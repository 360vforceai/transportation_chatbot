const OpenAI = require('openai');
const logger = require('../utils/logger');

const DEFAULT_SYSTEM_PROMPT = `You are an AI Transportation Assistant for a Discord server serving Rutgers University students, faculty, and staff.

You help users with two main things:

## 1. Getting Around Campus
Help users navigate between Rutgers campuses and buildings efficiently.

**Bus Tracking**: Provide live bus locations, arrival times, and route information for Rutgers buses.
**Campus Navigation**: Give directions between Rutgers buildings, with walking, bus, and driving options and estimated travel times.
**Public Transit**: Help users connect Rutgers transportation with NJ Transit trains and buses for commuter trip planning.
**Transportation Comparison**: Compare walking, bus, driving, biking, and train options — show the fastest and most convenient route.

## 2. Planning & Alerts
Help users avoid being late and stay informed about disruptions.

**Parking Assistant**: Find the nearest parking lots to a destination, explain permit eligibility by time and type, and estimate walking distance from lot to building.
**Leave-Now Assistant**: Based on the user's location and destination, predict whether they'll be late and recommend when to leave.
**Transportation Alerts**: Inform users of bus delays, detours, construction, and road closures.
**Accessibility**: Provide accessible routes, entrances, and transportation options for users who need them.

## General Rules:
- Be warm, practical, and specific — use real Rutgers bus route names (e.g. LX, EE, H, F, REXL) and real building names
- When live data is provided as context, reference it directly — never guess bus times or parking availability
- Always give estimated travel times when recommending a route
- If a user seems to be running late, prioritize speed over convenience
- Never make up bus schedules, parking rules, or building locations — only use provided context
- Encourage users to verify critical info on the Rutgers Bus app and NJ Transit website`;

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
const MODEL = 'gpt-4o-mini';

const TOOLS = [];

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }
    logger.info('OpenAI client init', { keyPrefix: apiKey.slice(0, 12) + '...' });
    client = new OpenAI({ apiKey });
  }
  return client;
}

function executeToolCall(name, args) {
  // Placeholder for future tools:
  // if (name === 'get_bus_location') { return queryBusTracker(args); }
  // if (name === 'get_parking_availability') { return queryParking(args); }
  // if (name === 'get_njtransit_schedule') { return queryNJTransit(args); }
  // if (name === 'get_travel_time') { return queryMapsAPI(args); }
  return `Unknown tool: ${name}`;
}

function sanitizeHistoryMessages(messages) {
  const safeMessages = [];
  let pendingToolCallIds = null;
  let droppedToolMessages = 0;

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'user') {
      safeMessages.push(msg);
      pendingToolCallIds = null;
      continue;
    }

    if (msg.role === 'assistant') {
      safeMessages.push(msg);
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        pendingToolCallIds = new Set(
          msg.tool_calls
            .map((tc) => tc?.id)
            .filter((id) => typeof id === 'string' && id.length > 0)
        );
      } else {
        pendingToolCallIds = null;
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      const isValid = pendingToolCallIds && toolCallId && pendingToolCallIds.has(toolCallId);
      if (isValid) {
        safeMessages.push(msg);
      } else {
        droppedToolMessages++;
      }
      continue;
    }
  }

  if (droppedToolMessages > 0) {
    logger.warn(`Dropped ${droppedToolMessages} orphaned tool message(s) from conversation history`);
  }

  return safeMessages;
}

// ── Router Agent ──────────────────────────────────────────────────────────────
// Decides which data sources to query and generates search keywords.
// Tables: "bus_routes", "parking", "buildings", "alerts", "njtransit"

const ROUTER_SYSTEM_PROMPT = `You are a query router for a Rutgers University transportation Discord bot.

Given a conversation history and the user's latest question, output a JSON object with exactly two fields:

1. "tables": array of data sources to query (can be empty for pure chit-chat).
   Valid values: "bus_routes", "parking", "buildings", "alerts", "njtransit"
   - bus_routes: Rutgers bus route info — route names, stops, schedules, live locations
   - parking: parking lot info — locations, permit types, hours, walking distances
   - buildings: Rutgers building locations and addresses across all campuses
   - alerts: live transportation alerts — delays, detours, closures, construction
   - njtransit: NJ Transit train and bus schedules for commuters

2. "keywords": a single short phrase (3-8 words) optimized for semantic vector search.

   ## bus_routes embedding format:
   "Route LX | Livingston to College Ave | Stops: Livingston Plaza, Tillet Hall, College Ave Student Center | Every 10 min"
   → Good keywords: route name + direction or stop ("LX bus Livingston College Ave", "bus to Busch campus")

   ## parking embedding format:
   "Lot 108 | Busch Campus | Permit: B, C | Hours: 24hr | Walking: 5 min to SERC"
   → Good keywords: lot name + campus or nearby building ("parking near SERC Busch", "Lot 108 permit")

   ## buildings embedding format:
   "Hill Center | Busch Campus | 110 Frelinghuysen Rd | Mathematics and Computer Science"
   → Good keywords: building name + campus ("Hill Center Busch", "CoRE building location")

   ## alerts embedding format:
   "Route H — Detour in effect due to construction on Hamilton St | As of 2:30 PM"
   → Good keywords: route or area + alert type ("Route H delay", "Livingston construction detour")

   ## njtransit embedding format:
   "NJ Transit Train — New Brunswick Station | Northeast Corridor Line | To NYC Penn Station | Departs 8:42 AM"
   → Good keywords: destination + transit type ("train New Brunswick NYC", "NJ Transit schedule")

   ## General keyword rules:
   - Convert campus nicknames: "CAC" → "College Ave", "Cook/Doug" → "Cook Douglass"
   - Strip filler words; focus on route names, building names, lot numbers, campus names
   - For navigation questions, route to "buildings" and "bus_routes"
   - For commuter questions, route to "njtransit" and "bus_routes"
   - For late/departure time questions, route to "bus_routes" and "buildings"

   ## Keyword examples:
   "how do I get from Busch to College Ave?" → tables: ["bus_routes", "buildings"], keywords: "bus Busch to College Ave route"
   "where can I park near Hill Center?" → tables: ["parking", "buildings"], keywords: "parking near Hill Center Busch"
   "is the LX running late?" → tables: ["alerts", "bus_routes"], keywords: "LX bus delay alert"
   "what train goes to NYC from New Brunswick?" → tables: ["njtransit"], keywords: "New Brunswick train NYC Penn Station"
   "where is the Werblin Rec Center?" → tables: ["buildings"], keywords: "Werblin Recreation Center Livingston"
   "I need to be at Scott Hall in 15 minutes" → tables: ["bus_routes", "buildings"], keywords: "bus to Scott Hall College Ave fast"
   "hey what's up" → tables: [], keywords: ""

Output ONLY valid JSON, no explanation, no markdown fences.`;

async function getRouterDecision(shortTermHistory, question) {
  const fallback = {
    tables: ['bus_routes', 'buildings'],
    keywords: question
  };

  try {
    const openai = getClient();

    const historyText =
      shortTermHistory.length > 0
        ? shortTermHistory
            .slice(-6)
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n')
        : '(no prior conversation)';

    const userContent = `Conversation history:\n${historyText}\n\nLatest question: ${question}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      max_tokens: 80,
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    const raw = response.choices[0]?.message?.content?.trim() || '';
    const parsed = JSON.parse(raw);

    const validTables = ['bus_routes', 'parking', 'buildings', 'alerts', 'njtransit'];
    const tables = Array.isArray(parsed.tables)
      ? parsed.tables.filter((t) => validTables.includes(t))
      : fallback.tables;

    const keywords =
      typeof parsed.keywords === 'string' && parsed.keywords.trim()
        ? parsed.keywords.trim()
        : question;

    logger.info('Router decision', { tables, keywords });
    return { tables, keywords };
  } catch (err) {
    logger.warn('getRouterDecision failed, using fallback:', err.message);
    return fallback;
  }
}

// ── Main Response Function ────────────────────────────────────────────────────

/**
 * Generates a response from the transportation advisor.
 * @param {Array} messages - full conversation history including latest user message
 * @param {Object} options
 * @param {string|null} options.busContext        - RAG results from bus_routes
 * @param {string|null} options.parkingContext    - RAG results from parking
 * @param {string|null} options.buildingContext   - RAG results from buildings
 * @param {string|null} options.alertContext      - RAG results from alerts
 * @param {string|null} options.njtransitContext  - RAG results from njtransit
 * @param {string|null} options.keywords          - search keywords used
 * @returns {Promise<{ content: string, messages: Array }>}
 */
async function getResponse(
  messages,
  {
    busContext = null,
    parkingContext = null,
    buildingContext = null,
    alertContext = null,
    njtransitContext = null,
    keywords = null
  } = {}
) {
  logger.info('getResponse called', {
    msgCount: messages.length,
    hasBus: !!busContext,
    hasParking: !!parkingContext,
    hasBuildings: !!buildingContext,
    hasAlerts: !!alertContext,
    hasNJTransit: !!njtransitContext
  });

  const systemMessage = { role: 'system', content: SYSTEM_PROMPT };
  const sanitizedHistory = sanitizeHistoryMessages(messages);

  const contextParts = [];
  const keywordsLine = keywords ? `Search keywords used: "${keywords}"\n\n` : '';

  if (alertContext) {
    // Inject alerts first — they're the most time-sensitive
    contextParts.push(`## ⚠️ Live Transportation Alerts
${keywordsLine}The following are current transportation alerts at Rutgers. Always mention relevant alerts before giving route advice.

${alertContext}

→ If an alert affects the user's route, warn them and suggest an alternative.`);
  }

  if (busContext) {
    contextParts.push(`## Rutgers Bus Routes
${keywordsLine}The following is Rutgers bus route and schedule data. Use it to answer questions about which bus to take, where to board, and estimated arrival times.

${busContext}

→ Always give the route name (e.g. LX, EE, H), the boarding stop, and estimated travel time.
→ If multiple routes work, list them in order of speed.`);
  }

  if (buildingContext) {
    contextParts.push(`## Campus Buildings & Locations
${keywordsLine}The following is Rutgers building location data. Use it to answer questions about where buildings are and which campus they're on.

${buildingContext}

→ Always mention which campus (Busch, College Ave, Livingston, Cook/Douglass) the building is on.
→ Include the address if available.`);
  }

  if (parkingContext) {
    contextParts.push(`## Parking Lots & Permits
${keywordsLine}The following is Rutgers parking lot data. Use it to answer questions about where to park and what permits are valid.

${parkingContext}

→ Always mention the permit type required and the walking distance to the destination.
→ Note any time-based permit rules (e.g. "permit required until 5 PM, open after").`);
  }

  if (njtransitContext) {
    contextParts.push(`## NJ Transit Schedules
${keywordsLine}The following is NJ Transit train and bus schedule data for Rutgers commuters.

${njtransitContext}

→ Give specific departure times and estimated travel durations.
→ Mention which station to board at and where to exit.`);
  }

  let apiMessages;
  if (contextParts.length > 0) {
    const contextMessage = {
      role: 'system',
      content: contextParts.join('\n\n---\n\n')
    };
    const historyWithoutLast = sanitizedHistory.slice(0, -1);
    const lastMessage = sanitizedHistory[sanitizedHistory.length - 1];
    apiMessages = [systemMessage, ...historyWithoutLast, contextMessage, lastMessage];
  } else {
    apiMessages = [systemMessage, ...sanitizedHistory];
  }

  try {
    const openai = getClient();

    let response;
    let iterations = 0;
    const maxIterations = 5;

    do {
      const reqParams = {
        model: MODEL,
        messages: apiMessages,
        max_tokens: 1024
      };
      if (TOOLS.length > 0) {
        reqParams.tools = TOOLS;
        reqParams.tool_choice = 'auto';
      }

      response = await openai.chat.completions.create(reqParams);

      const choice = response.choices[0];
      const msg = choice?.message;

      if (!msg) {
        logger.warn('OpenAI returned no message', response);
        return {
          content: 'I could not generate a response. Please try again.',
          messages: apiMessages
        };
      }

      if (choice.finish_reason === 'tool_calls' && msg.tool_calls?.length) {
        apiMessages.push(msg);
        for (const tc of msg.tool_calls) {
          const fn = tc.function;
          let args = {};
          try {
            args = JSON.parse(fn.arguments || '{}');
          } catch (e) {
            logger.warn('Invalid tool arguments', fn.arguments);
          }
          const result = await executeToolCall(fn.name, args);
          apiMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: typeof result === 'string' ? result : JSON.stringify(result)
          });
        }

        iterations++;
        if (iterations >= maxIterations) {
          return {
            content: 'Sorry, I had trouble completing that request. Please try again.',
            messages: apiMessages
          };
        }
        continue;
      }

      const content = msg.content?.trim() || '';
      if (content) {
        apiMessages.push(msg);
        return { content, messages: apiMessages };
      }

      logger.warn('OpenAI returned empty content', response);
      return {
        content: 'I could not generate a response. Please try again.',
        messages: apiMessages
      };
    } while (true);
  } catch (err) {
    logger.error('OpenAI API error', {
      status: err.status,
      message: err.message,
      type: err.type || err.error?.type
    });
    if (err.status === 429) {
      return {
        content: 'Rate limit exceeded. Please try again in a moment.',
        messages: apiMessages
      };
    }
    if (err.status === 401) {
      return {
        content: 'API configuration error. Please contact the bot administrator.',
        messages: apiMessages
      };
    }
    return {
      content: 'Sorry, I encountered an error. Please try again later.',
      messages: apiMessages
    };
  }
}

module.exports = {
  getResponse,
  getRouterDecision,
  getClient
};