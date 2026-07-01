const { isRateLimited, recordRequest, getRemainingSeconds } = require('../utils/rateLimiter');
const { splitMessage } = require('../utils/messageUtils');
const { getResponse, getRouterDecision } = require('../agents/aiClient');
const { findBuilding, findNearestLots, findResidentLots, findFlexLots, checkPermitEligibility } = require('../utils/parkingHelper');
const { parseTime, resolveOrigin, getTravelTimes, subtractMinutes, formatTime12h } = require('../utils/googleMapsClient');
const {
  getShortTermHistory,
  searchLongTermMemories,
  saveMemoryAsync
} = require('../utils/memoryService');
const {
  // TODO: import data functions from transportationClient.js as they are built
  // searchBusRoutes,
  // formatBusContext,
  // searchParking,
  // formatParkingContext,
  // searchBuildings,
  // formatBuildingContext,
  // formatAlertContext,
  // fetchLiveBusLocations,
  // fetchParkingAvailability,
  //searchNJTransit,
  formatNJTransitContext,
 // fetchLiveAlerts,
  getAlertsForRoadway,
  fetchPortAuthorityAlerts, 
  formatPortAuthorityEmbed,
  fetchACEAlerts, 
  formatACEEmbed,
} = require('../agents/transportationClient');
const logger = require('../utils/logger');

// Prevent Discord Gateway from replaying the same interaction, avoiding duplicate processing.
const handledInteractions = new Map();

const { createParkingEmbed } = require('../utils/embedFactory');

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Periodically purge IDs older than 10 minutes (interaction tokens expire after 15 min).
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, timestamp] of handledInteractions.entries()) {
    if (timestamp < cutoff) handledInteractions.delete(id);
  }
}, 10 * 60 * 1000);

// ── Shared helper: send chunks back to Discord ────────────────────────────────

async function sendChunks(interaction, content) {
  const chunks = splitMessage(content);
  if (chunks.length === 0) {
    await interaction
      .editReply('I could not generate a response. Please try again.')
      .catch((err) => logger.error('Edit reply failed:', err.message));
    return;
  }
  await interaction
    .editReply(chunks[0])
    .catch((err) => logger.error('Edit reply failed:', err.message));
  for (let i = 1; i < chunks.length; i++) {
    await interaction
      .followUp({ content: chunks[i] })
      .catch((err) => logger.error('Follow-up failed:', err.message));
  }
}

// ── Shared helper: run RAG + getResponse for a question string ────────────────
// Queries all relevant transportation data sources in parallel based on router decision,
// then injects context into the AI response.

async function runAdvisor(userId, username, question) {
  const shortTermHistory = await getShortTermHistory(userId);
  const { tables, keywords } = await getRouterDecision(shortTermHistory, question);

  logger.info('Router decision applied', { userId, tables, keywords });

  // TODO: replace Promise.resolve([]) with actual search calls as transportationClient.js is built
  const [
    { memories, embedding },
    // busResults,
    // parkingResults,
    // buildingResults,
    // alertResults,
    // njtransitResults,
  ] = await Promise.all([
    tables.includes('community_memory')
      ? searchLongTermMemories(keywords)
      : Promise.resolve({ memories: [], embedding: null }),

    // tables.includes('bus_routes')    ? searchBusRoutes(keywords)   : Promise.resolve([]),
    // tables.includes('parking')       ? searchParking(keywords)     : Promise.resolve([]),
    // tables.includes('buildings')     ? searchBuildings(keywords)   : Promise.resolve([]),
    // tables.includes('alerts')        ? searchAlerts(keywords)      : Promise.resolve([]),
    // tables.includes('njtransit')     ? searchNJTransit(keywords)   : Promise.resolve([]),
  ]);

  const ragContext = memories.length > 0
    ? memories.map((m) => {
        const name = m.metadata?.username || `user ID ${m.user_id}`;
        return `Discord user "@${name}" previously said: "${m.content}"`;
      }).join('\n')
    : null;

  // TODO: format contexts as transportationClient.js is built
  // const busContext       = formatBusContext(busResults);
  // const parkingContext   = formatParkingContext(parkingResults);
  // const buildingContext  = formatBuildingContext(buildingResults);
  // const alertContext     = formatAlertContext(alertResults);
  // const njtransitContext = formatNJTransitContext(njtransitResults);

  const messages = [...shortTermHistory, { role: 'user', content: question }];

  const { content } = await getResponse(messages, {
    // busContext,
    // parkingContext,
    // buildingContext,
    // alertContext,
    // njtransitContext,
    keywords
  });

  saveMemoryAsync(userId, username, question, content, embedding);
  return content;
}

// ── /bus ─────────────────────────────────────────────────────────────────────
// Live bus tracking — shows current bus locations and next arrivals for a route.
// Data source: Rutgers bus tracker API (live)
// Options: route (required) — e.g. "LX", "EE", "H"
// TODO: call fetchLiveBusLocations(route) and format into an embed with stops + ETAs

async function handleBus(interaction, userId, username) {
  // const route = interaction.options.getString('route');
  await interaction.editReply('🚌 `/bus` — Bus tracker coming soon.');
  logger.info('Handled /bus (stub)', { userId });
}

// ── /navigate ────────────────────────────────────────────────────────────────
// Campus navigation — gives directions from one Rutgers location to another.
// Data sources: buildings (RAG), bus_routes (RAG)
// Options: from (required), to (required), mode (optional: bus/walk/drive)
// TODO: query buildings for both locations, then find connecting bus routes,
//       and compute estimated travel time. Return step-by-step directions embed.

async function handleNavigate(interaction, userId, username) {
  // const from = interaction.options.getString('from');
  // const to   = interaction.options.getString('to');
  // const mode = interaction.options.getString('mode') || 'bus';
  await interaction.editReply('🗺️ `/navigate` — Campus navigation coming soon.');
  logger.info('Handled /navigate (stub)', { userId });
}

// ── /parking ─────────────────────────────────────────────────────────────────
// Parking assistant — finds nearby lots, permit requirements, and walking distance.
// Data sources: parking (RAG), buildings (RAG), live parking availability API
// Options: destination (required), permit (optional — e.g. "A", "B", "C", "staff")

async function handleParking(interaction, userId, username) {
  const destination = interaction.options.getString('destination');
  const permitType = interaction.options.getString('permit_type');
  const homeCampus = interaction.options.getString('home_campus');
  const time = interaction.options.getString('time') ||
    new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });


  const building = await findBuilding(destination);

  if (!building) {
    await interaction.editReply(
      `🅿️ I couldn't find "${destination}" in my building list. Try searching by a specific hall or student center name.`
    );
    return;
  }

  // ── Dorm branch ───────────────────────────────────────────────────────────
  if (building.is_dorm) {
    if (!permitType) {
      await interaction.editReply(
        `🏠 **${building.name}** is a residence hall. Re-run \`/parking\` with your \`permit_type\` (Commuter or Resident) and \`home_campus\` to see your parking options.`
      );
      return;
    }

    if (permitType === 'resident') {
      const campus = homeCampus || building.campus;
      const [homeLots, flexLots] = await Promise.all([
        findResidentLots(building, campus),
        findFlexLots(building)
      ]);

      const lots = [
        ...homeLots.map(l => ({ ...l, status: '✅ Your home lot (24/7)' })),
        ...flexLots.map(l => ({ ...l, status: '✅ Eligible (resident flex, 5PM–12AM Mon–Fri)' }))
      ];

      logger.info('lots being passed to embed', lots.map(l => ({ name: l.name, status: l.status })));


      const embed = createParkingEmbed(building, lots);
      await interaction.editReply({ embeds: [embed] });
      logger.info('Handled /parking (resident dorm)', { userId, destination, campus, time });
      return;
    }

    if (permitType === 'commuter') {
      const { lots: rawLots } = await findNearestLots(building);

      const lots = await Promise.all(rawLots.map(async (lot) => {
        const { eligible, matchedRule } = await checkPermitEligibility(lot, permitType, homeCampus, time);
        const status = eligible && matchedRule === 'flex' ? '✅ Eligible (flex time)'
          : eligible ? '✅ Eligible'
          : '❌ Not available until 5pm';
        return { ...lot, status };
      }));

      const embed = createParkingEmbed(building, lots);
      await interaction.editReply({ embeds: [embed] });
      logger.info('Handled /parking (commuter dorm)', { userId, destination, homeCampus, time });
      return;
    }
  }

  // ── Non-dorm branch ───────────────────────────────────────────────────────
  const { lots: rawLots } = await findNearestLots(building);

  if (!rawLots.length) {
    await interaction.editReply(`🅿️ No lots found near **${building.name}**.`);
    return;
  }

  const lots = await Promise.all(rawLots.map(async (lot) => {
    const { eligible, matchedRule } = await checkPermitEligibility(lot, permitType, homeCampus, time);
    let status = '✅ Open to all';
    if (permitType) {
      if (eligible && matchedRule === 'flex') status = '✅ Eligible (flex time)';
      else if (eligible && matchedRule === 'residentFlex') status = '✅ Eligible (resident flex)';
      else if (eligible) status = '✅ Eligible';
      else status = '❌ Not available until 5pm';
    }
    return { ...lot, status };
  }));

  const embed = createParkingEmbed(building, lots);
  await interaction.editReply({ embeds: [embed] });
  logger.info('Handled /parking', { userId, destination, permitType, homeCampus, time });
}

// ── /leavenow ────────────────────────────────────────────────────────────────
// Leave-now assistant — tells the user when to leave to arrive at a destination on time.
// Data sources: bus_routes (RAG), buildings (RAG), alerts (RAG)
// Options: destination (required), arrival_time (required), from (optional — defaults to current campus)
// TODO: calculate travel time from bus routes + walking, subtract from arrival_time,
//       check alerts for delays, return recommended departure time embed.

async function handleTransit(interaction, userId, username) {
  await interaction.editReply('🚆 `/transit` — NJ Transit schedules coming soon.');
  logger.info('Handled /transit (stub)', { userId });
}

async function handleLeaveNow(interaction, userId, username) {
  const destination = interaction.options.getString('destination');
  const arrivalTimeRaw = interaction.options.getString('arrival_time');
  const from = interaction.options.getString('from');
  const homeCampus = interaction.options.getString('home_campus');

  // parse arrival time
  const arrivalTime = parseTime(arrivalTimeRaw);
  if (!arrivalTime) {
    await interaction.editReply(
      `⏱️ Couldn't parse "${arrivalTimeRaw}" as a time. Try formats like \`9:00am\`, \`14:30\`, or \`2:30pm\`.`
    );
    return;
  }

  // resolve origin
  const origin = await resolveOrigin(from, homeCampus);
  if (!origin) {
    await interaction.editReply(
      `⏱️ Please provide a \`from\` address or select a \`home_campus\` so I know where you're starting from.`
    );
    return;
  }

  // find destination building
  const building = await findBuilding(destination);
  if (!building) {
    await interaction.editReply(
      `⏱️ I couldn't find "${destination}" in my building list. Try a specific hall or student center name.`
    );
    return;
  }

  // get travel times
  const { walking, driving } = await getTravelTimes(
    origin.lat, origin.lng,
    building.latitude, building.longitude
  );

  if (!walking && !driving) {
    await interaction.editReply(`⏱️ Couldn't fetch travel times right now. Please try again.`);
    return;
  }

  // current time as HH:MM
  const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

  // build response lines
  const lines = [`⏱️ **Leave-Now for ${building.name} by ${formatTime12h(arrivalTime)}**`, ''];

  if (driving !== null) {
    const leaveBy = subtractMinutes(arrivalTime, driving);
    // const buffer = (arrivalTime.replace(':', '') > now.replace(':', ''))
      // ? Math.max(0, (parseInt(arrivalTime) - parseInt(now)) - driving)
      // : 0;
    const leaveByFormatted = formatTime12h(leaveBy);
    const late = leaveBy < now;
    lines.push(`🚗 **Driving** — ${driving} min → Leave by **${leaveByFormatted}**${late ? ' ⚠️ Already late!' : ''}`);
  }

  if (walking !== null) {
    const leaveBy = subtractMinutes(arrivalTime, walking);
    const leaveByFormatted = formatTime12h(leaveBy);
    const late = leaveBy < now;
    lines.push(`🚶 **Walking** — ${walking} min → Leave by **${leaveByFormatted}**${late ? ' ⚠️ Already late!' : ''}`);
  }

  lines.push('', `📍 From: ${origin.label}`);

  await interaction.editReply(lines.join('\n'));
  logger.info('Handled /leavenow', { userId, destination, arrivalTime, from, homeCampus });
}

// ── /compare ─────────────────────────────────────────────────────────────────
// Transportation comparison — compares bus, walking, driving, biking, and train options.
// Data sources: bus_routes (RAG), buildings (RAG), njtransit (RAG)
// Options: from (required), to (required)
// TODO: run parallel queries for bus routes and buildings, estimate travel times
//       for each mode, return a comparison embed sorted by speed.

async function handleCompare(interaction, userId, username) {
  // const from = interaction.options.getString('from');
  // const to   = interaction.options.getString('to');
  await interaction.editReply('⚖️ `/compare` — Transportation comparison coming soon.');
  logger.info('Handled /compare (stub)', { userId });
}

// ── /alerts ─────────────────────────────────────────────────────────────────

async function handleAlerts(interaction, userId, username) {
  const roadway = interaction.options.getString('roadway');
 
  // Fire sources in parallel – each degrades gracefully if blocked
  const [njtaResult, panynjResult, aceResult] = await Promise.allSettled([
    // NJTA: Turnpike + GSP (already working)
    getAlertsForRoadway(roadway === 'ace' || roadway === 'panynj' ? 'all' : roadway),
 
    // Port Authority: bridges, tunnels, PATH
    (roadway === 'panynj' || roadway === 'all') ? fetchPortAuthorityAlerts() : Promise.resolve(null),
 
    // Atlantic City Expressway
    (roadway === 'ace' || roadway === 'all') ? fetchACEAlerts() : Promise.resolve(null),
  ]);
 
  const embeds = [];
 
  // ── NJTA embed (Turnpike + GSP) ───────────────────────────────────────────
  if (roadway !== 'ace' && roadway !== 'panynj') {
    const { turnpike, gsp } = njtaResult.status === 'fulfilled'
      ? njtaResult.value
      : { turnpike: [], gsp: [] };
 
    const allAlerts = [...turnpike, ...gsp];
 
    if (allAlerts.length === 0) {
      embeds.push({
        color: 0x57F287,
        title: `✅ No Major Delays — ${
          roadway === 'turnpike' ? 'NJ Turnpike' :
          roadway === 'gsp' ? 'Garden State Parkway' : 'Turnpike & Parkway'
        }`,
        description: 'No major delays currently reported.',
        footer: { text: 'Live data from NJTA · njta.gov' },
        timestamp: new Date().toISOString()
      });
    } else {
      const fields = allAlerts.slice(0, 10).map(a => ({
        name: `${a.is_major ? '🔴' : '🟡'} ${a.types || 'Alert'} — ${a.relative || ''}`,
        value: (a.description || 'No details').slice(0, 200),
        inline: false
      }));
 
      embeds.push({
        color: allAlerts.some(a => a.is_major) ? 0xED4245 : 0xFEE75C,
        title: `⚠️ Traffic Alerts — ${
          roadway === 'turnpike' ? 'NJ Turnpike' :
          roadway === 'gsp' ? 'Garden State Parkway' : 'Turnpike & Parkway'
        }`,
        description: `${allAlerts.length} alert(s) found.`,
        fields,
        footer: { text: 'Live data from NJTA · njta.gov' },
        timestamp: new Date().toISOString()
      });
    }
  }
 
  // ── Port Authority embed ──────────────────────────────────────────────────
  if (panynjResult.status === 'fulfilled' && panynjResult.value !== null) {
    embeds.push(formatPortAuthorityEmbed(panynjResult.value));
  }
 
  // ── Atlantic City Expressway embed ────────────────────────────────────────
  if (aceResult.status === 'fulfilled' && aceResult.value !== null) {
    embeds.push(formatACEEmbed(aceResult.value));
  }
 
  // Discord allows max 10 embeds per message
  const toSend = embeds.slice(0, 10);
 
  if (toSend.length === 0) {
    await interaction.editReply('No alert data available right now. Please try again shortly.');
    return;
  }
 
  await interaction.editReply({ embeds: toSend });
  logger.info('Handled /alerts', { userId, roadway, embedCount: toSend.length });
}

// ── /access ──────────────────────────────────────────────────────────────────
// Accessibility assistant — accessible routes, entrances, and transportation options.
// Data sources: buildings (RAG — accessible entrance data), bus_routes (RAG — accessible buses)
// Options: destination (required), need (optional — e.g. "elevator", "ramp", "accessible bus")
// TODO: query buildings for accessible entrance info and bus_routes for ADA-accessible
//       vehicles. Return step-by-step accessible directions embed.

async function handleAccess(interaction, userId, username) {
  // const destination = interaction.options.getString('destination');
  // const need        = interaction.options.getString('need');
  await interaction.editReply('♿ `/access` — Accessibility assistant coming soon.');
  logger.info('Handled /access (stub)', { userId });
}

// ── /ask ─────────────────────────────────────────────────────────────────────
// General transportation question — routes through the full RAG pipeline.
// Data sources: all tables via router agent
// Options: question (required)
// Handles anything not covered by the specific commands above.

async function handleAsk(interaction, userId, username) {
  const question = interaction.options.getString('question');
  if (!question) {
    await interaction.reply({ content: 'Please provide a question.', ephemeral: true })
      .catch((err) => logger.error('Reply failed:', err.message));
    return;
  }
  const content = await runAdvisor(userId, username, question);
  await sendChunks(interaction, content);
  logger.info('Handled /ask', { userId, username, questionLength: question.length });
}

// ── /help ─────────────────────────────────────────────────────────────────────

async function handleHelp(interaction) {
  const helpText = [
    '**Rutgers Transportation Assistant — Commands**',
    '',
    '`/bus <route>` — Live bus locations and next arrivals (e.g. LX, EE, H, F).',
    '`/navigate <from> <to> [mode]` — Step-by-step directions between Rutgers locations.',
    '`/parking <destination> [permit]` — Find nearby parking lots and permit requirements.',
    '`/transit <destination> [time]` — NJ Transit train and bus schedules for commuters.',
    '`/leavenow <destination> <arrival_time>` — When should you leave to arrive on time?',
    '`/compare <from> <to>` — Compare bus, walking, driving, and train options side by side.',
    '`/alerts [route]` — Live bus delays, detours, construction, and road closures.',
    '`/access <destination> [need]` — Accessible routes, entrances, and transportation.',
    '`/ask <question>` — Ask anything about Rutgers transportation.',
    '`/help` — Show this message.',
    '',
    'Always verify critical info on the Rutgers Bus app and NJ Transit website.'
  ].join('\n');

  await interaction.editReply(helpText)
    .catch((err) => logger.error('Help reply failed:', err.message));

  logger.info('Handled /help');
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const validCommands = ['bus', 'navigate', 'parking', 'transit', 'leavenow', 'compare', 'alerts', 'access', 'ask', 'help'];
  if (!validCommands.includes(commandName)) return;

  const userId = interaction.user.id;
  const username = interaction.user.username;

  logger.info('Interaction received', { userId, command: commandName, id: interaction.id });

  if (handledInteractions.has(interaction.id)) {
    logger.warn('Duplicate interaction skipped', { id: interaction.id });
    return;
  }
  handledInteractions.set(interaction.id, Date.now());

  if (isRateLimited(userId)) {
    const remaining = getRemainingSeconds(userId);
    await interaction.reply({
      content: `Please wait ${remaining} second(s) before using another command.`,
      ephemeral: true
    }).catch((err) => logger.error('Reply failed:', err.message));
    return;
  }
  recordRequest(userId);

  try {
    await interaction.deferReply();
  } catch (err) {
    logger.error('Defer failed (interaction expired or already handled):', err.message);
    return;
  }

  try {
    if (commandName === 'bus')       await handleBus(interaction, userId, username);
    if (commandName === 'navigate')  await handleNavigate(interaction, userId, username);
    if (commandName === 'parking')   await handleParking(interaction, userId, username);
    if (commandName === 'transit')   await handleTransit(interaction, userId, username);
    if (commandName === 'leavenow')  await handleLeaveNow(interaction, userId, username);
    if (commandName === 'compare')   await handleCompare(interaction, userId, username);
    if (commandName === 'alerts')    await handleAlerts(interaction, userId, username);
    if (commandName === 'access')    await handleAccess(interaction, userId, username);
    if (commandName === 'ask')       await handleAsk(interaction, userId, username);
    if (commandName === 'help')      await handleHelp(interaction);
  } catch (err) {
    logger.error('Interaction handler error:', err.message);
    await interaction
      .editReply('Sorry, something went wrong. Please try again later.')
      .catch((editErr) => logger.error('Fallback edit failed:', editErr.message));
  }
}

async function handleAutocomplete(interaction) {
  try {
    if (!['parking', 'leavenow'].includes(interaction.commandName)) {
      return interaction.respond([]);
    }

    const focused = interaction.options.getFocused();

    let query = supabase
      .from("app_rutgers_buildings")
      .select("name, campus")
      .limit(25);

    if (focused) {
      query = query.or(`name.ilike.${focused}%,name.ilike.%${focused}%`);
    } else {
      query = query.order('name', { ascending: true });
    }

    const { data, error } = await query;

    if (error) {
      logger.error("Autocomplete failed:", error.message);
      return interaction.respond([]);
    }

    await interaction.respond(
      data.map((building) => ({
        name: `${building.name} • ${building.campus.replace("Rutgers University - ", "")}`,
        value: building.name
      }))
    );
  } catch (err) {
    logger.error("Autocomplete exception:", err.message);
    try { interaction.respond([]); } catch (_) {}
  }
}

module.exports = { handleInteraction,
   handleAutocomplete
};