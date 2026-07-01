const { isRateLimited, recordRequest, getRemainingSeconds } = require('../utils/rateLimiter');
const { splitMessage } = require('../utils/messageUtils');
const { getResponse, getRouterDecision } = require('../agents/aiClient');
const { findBuilding, findNearestLots, findResidentLots, findFlexLots, checkPermitEligibility } = require('../utils/parkingHelper');
const { setStationList, fetchNJTDepartures, formatNJTEmbed, refreshAliases } = require('../agents/njtransit_scraper');
const {
  getShortTermHistory,
  searchLongTermMemories,
  saveMemoryAsync
} = require('../utils/memoryService');
const {
  formatNJTransitContext,
  getAlertsForRoadway,
  fetchPortAuthorityAlerts, 
  formatPortAuthorityEmbed,
  fetchACEAlerts, 
  formatACEEmbed,
  searchAccessibility, 
} = require('../agents/transportationClient');
const navigationHelper = require('../utils/navigationHelper');
const passioClient = require('../agents/passioClient');
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
    busResults,
    buildingResults,
    // parkingResults,
    // alertResults,
    // njtransitResults,
  ] = await Promise.all([
    tables.includes('community_memory')
      ? searchLongTermMemories(keywords)
      : Promise.resolve({ memories: [], embedding: null }),

    tables.includes('bus_routes')    ? searchBusRoutes(keywords)   : Promise.resolve([]),
    tables.includes('buildings')     ? searchBuildings(keywords)   : Promise.resolve([]),
    // tables.includes('parking')       ? searchParking(keywords)     : Promise.resolve([]),
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
  const busContext = formatBusContext(busResults);
  const buildingContext = formatBuildingContext(buildingResults);
  // const parkingContext   = formatParkingContext(parkingResults);
  // const alertContext     = formatAlertContext(alertResults);
  // const njtransitContext = formatNJTransitContext(njtransitResults);

  const messages = [...shortTermHistory, { role: 'user', content: question }];

  const { content } = await getResponse(messages, {
    busContext,
    buildingContext,
    // parkingContext,
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
  const routeQuery = interaction.options.getString('route');

  if (!routeQuery) {
    const [allVehicles, routes] = await Promise.all([
      passioClient.fetchVehicles(),
      passioClient.fetchRoutes()
    ]);
    const vehicles = await passioClient.filterNBVehicles(allVehicles);
    const activeRouteIds = new Set(vehicles.map((v) => String(v.routeId)));
    const activeRoutes = routes.filter((r) => activeRouteIds.has(String(r.id)));

    if (activeRoutes.length === 0) {
      await interaction.editReply('🚌 No buses are currently active. Try again during normal service hours, or specify a route with `/bus route:`.');
      return;
    }
    const lines = activeRoutes.map((r) => `• **${r.name}**`).sort();
    await interaction.editReply([
      `🚌 **Currently active routes** (${activeRoutes.length}):`,
      ...lines,
      '',
      'Use `/bus route:<name>` to see live locations and arrivals for a route.'
    ].join('\n'));
    logger.info('Handled /bus (route list)', { userId, activeRouteCount: activeRoutes.length });
    return;
  }

  const route = await passioClient.findRouteByQuery(routeQuery);
  if (!route) {
    // Tell the user what IS currently available
    const routes = await passioClient.fetchRoutes();
    const routeList = routes.map((r) => r.name).join(', ');
    await interaction.editReply(
      `🚌 No route matching "${routeQuery}" is currently running.\n\n` +
      `**Currently configured routes:** ${routeList || 'none'}\n\n` +
      `Semester routes (LX, EE, H, B, etc.) only run during the Fall and Spring semesters.`
    );
    return;
  }

  // Get live vehicles and stops for this route in parallel
  const [vehicles, stops] = await Promise.all([
    passioClient.getVehiclesForRoute(route.id),
    passioClient.getStopsForRoute(route.id)
  ]);

  const stopNames = stops.slice(0, 6).map((s) => s.name).filter(Boolean);
  const routeInfo = [
    `**Route:** ${route.name}`,
    stopNames.length ? `**Stops:** ${stopNames.join(' → ')}${stops.length > 6 ? ` (+${stops.length - 6} more)` : ''}` : null,
    route.serviceTime ? `**Service:** ${route.serviceTime}` : null,
  ].filter(Boolean).join('\n');

  if (vehicles.length === 0) {
    await interaction.editReply([
      `🚌 **${route.name}**`,
      '',
      routeInfo,
      '',
      '⚠️ No buses are currently being tracked on this route. It may be outside service hours.'
    ].join('\n'));
    logger.info('Handled /bus (no active vehicles)', { userId, routeId: route.id });
    return;
  }

  // For each vehicle, find nearest stop and attempt ETA
  const nearestStopLookups = await Promise.all(
    vehicles.map((v) => passioClient.findNearestStops(v.latitude, v.longitude, 1))
  );

  // Try ETA endpoint for the first few stops on the route
  const firstStopIds = stops.slice(0, 5).map((s) => s.stopId || s.id).filter(Boolean);
  const etaData = firstStopIds.length
    ? await passioClient.fetchEta(route.id, firstStopIds)
    : null;

  // Build ETA map: stopId -> minutes
  const etaMap = {};
  if (etaData) {
    try {
      const etaList = Array.isArray(etaData) ? etaData : Object.values(etaData);
      for (const entry of etaList) {
        if (entry.stopId && entry.seconds != null) {
          etaMap[String(entry.stopId)] = Math.round(entry.seconds / 60);
        }
      }
    } catch (_) {}
  }

  const vehicleLines = vehicles.map((v, i) => {
    const nearStop = nearestStopLookups[i][0];
    const speedText = v.speed != null ? `${Math.round(v.speed)} mph` : null;
    const nearText = nearStop ? `near **${nearStop.name}**` : 'location updating';
    const etaMin = nearStop ? etaMap[String(nearStop.id)] : null;
    const etaText = etaMin != null ? ` — arriving in ~${etaMin} min` : (speedText ? ` — ${speedText}` : '');
    return `🚍 **Bus ${v.name || v.id}** — ${nearText}${etaText}`;
  });

  const reply = [
    `🚌 **${route.name}** (${vehicles.length} bus${vehicles.length > 1 ? 'es' : ''} active)`,
    '',
    routeInfo,
    '',
    ...vehicleLines,
    '',
    `🗺️ Live map: https://rutgers.passiogo.com/?route=${route.id}`
  ].join('\n');

  await interaction.editReply(reply);
  logger.info('Handled /bus', { userId, routeId: route.id, activeVehicles: vehicles.length, hasEta: Object.keys(etaMap).length > 0 });
}

// ── /navigate ────────────────────────────────────────────────────────────────
// Campus navigation — gives directions from one Rutgers location to another.
// Data sources: buildings (RAG), bus_routes (RAG)
// Options: from (required), to (required), mode (optional: bus/walk/drive)
// TODO: query buildings for both locations, then find connecting bus routes,
//       and compute estimated travel time. Return step-by-step directions embed.

const MODE_EMOJI = { walking: '🚶', bus: '🚌', driving: '🚗' };

function formatBusField(bus) {
  if (!bus || !bus.found) {
    return {
      name: `${MODE_EMOJI.bus} Bus`,
      value: bus?.reason || 'No bus option available for this trip.',
      inline: false
    };
  }
  return {
    name: `${MODE_EMOJI.bus} Bus — ~${bus.totalMin} min (Route ${bus.routeShortName})`,
    value: [
      `Walk ${bus.walkToStopMin} min to **${bus.boardStopName}**`,
      `Wait ~${bus.waitMin} min, ride ~${bus.rideMin} min to **${bus.alightStopName}**`,
      `Walk ${bus.walkFromStopMin} min to destination`,
      `_${bus.liveTrackingNote}_`
    ].join('\n'),
    inline: false
  };
}

async function handleNavigate(interaction, userId, username) {
  const from = interaction.options.getString('from');
  const to = interaction.options.getString('to');
  const mode = interaction.options.getString('mode'); // 'walking' | 'bus' | 'driving' | null

  const directions = await navigationHelper.getDirections(from, to, mode);

  if (directions.error) {
    await interaction.editReply(
      `🗺️ I couldn't find "${directions.missing}" in my building list yet. Try a campus student center or a major building (e.g. "Busch Student Center", "Hill Center", "College Ave Student Center").`
    );
    logger.info('Handled /navigate (building not found)', { userId, from, to, missing: directions.missing });
    return;
  }

  const { from: fromB, to: toB, distanceMiles, sameCampus, walking, driving, bus } = directions;

  const embed = {
    color: 0x5865F2,
    title: `🗺️ ${fromB.name} → ${toB.name}`,
    description: sameCampus
      ? `Both on **${fromB.campus}** campus — ${distanceMiles.toFixed(2)} mi direct.`
      : `**${fromB.campus}** → **${toB.campus}** — ${distanceMiles.toFixed(2)} mi direct.`,
    fields: [],
    footer: { text: 'Estimates only — always verify live conditions on Passio Go.' },
    timestamp: new Date().toISOString()
  };

  if (mode === 'walking') {
    embed.fields.push({ name: `${MODE_EMOJI.walking} Walking`, value: `~${walking.minutes} min`, inline: false });
  } else if (mode === 'driving') {
    embed.fields.push({ name: `${MODE_EMOJI.driving} Driving`, value: `~${driving.minutes} min (plus parking — try \`/parking\`)`, inline: false });
  } else if (mode === 'bus') {
    embed.fields.push(formatBusField(bus));
  } else {
    // No mode specified — show a comparison of all three.
    embed.fields.push({ name: `${MODE_EMOJI.walking} Walking`, value: `~${walking.minutes} min`, inline: true });
    embed.fields.push({ name: `${MODE_EMOJI.driving} Driving`, value: `~${driving.minutes} min`, inline: true });
    embed.fields.push(formatBusField(bus));
  }

  await interaction.editReply({ embeds: [embed] });
  logger.info('Handled /navigate', { userId, from, to, mode: mode || 'all', busFound: !!bus?.found });
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

async function handleLeaveNow(interaction, userId, username) {
  // const destination   = interaction.options.getString('destination');
  // const arrivalTime   = interaction.options.getString('arrival_time');
  // const from          = interaction.options.getString('from');
  await interaction.editReply('⏱️ `/leavenow` — Leave-now assistant coming soon.');
  logger.info('Handled /leavenow (stub)', { userId });
}

// ── /transit ──────────────────────────────────────────────────────────────
// NJ Transit real-time departures via DepartureVision scraping
// Options: station (required), limit (optional, default 8)
 
async function handleTransit(interaction, userId, username) {
  const stationInput = interaction.options.getString('station');
  const limit = interaction.options.getInteger('limit') || 8;
 
  const result = await fetchNJTDepartures(stationInput);
 
  const embed = formatNJTEmbed(result, limit);
  await interaction.editReply({ embeds: [embed] });
 
  logger.info('Handled /transit', {
    userId,
    station: result.station,
    departures: result.departures?.length ?? 0
  });
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

// ── /access ───────────────────────────────────────────────────────────────
// Accessibility assistant — campus buses, parking, entrances, RADR, paratransit
// Options: topic (required), campus (optional)
 
async function handleAccess(interaction, userId, username) {
  const topic = interaction.options.getString('topic');
  const campus = interaction.options.getString('campus') || 'all';

  logger.info('handleAccess started', { userId, topic, campus });

  const searchQuery = campus !== 'all' ? `${topic} ${campus} campus` : topic;

  let results = [];
  try {
    results = await searchAccessibility(searchQuery, campus);
    logger.info('searchAccessibility returned', { count: results?.length || 0 });
  } catch (err) {
    logger.error('searchAccessibility failed:', err.message);
    await interaction.editReply({ embeds: [fallbackEmbed(topic, campus)] });
    return;
  }

  if (!results || results.length === 0) {
    await interaction.editReply({ embeds: [fallbackEmbed(topic, campus)] });
    return;
  }

  const topResults = results.slice(0, 3);
  const context = topResults.map((r, i) =>
    `[Source ${i+1}]: ${r.content}`
  ).join('\n\n');

  const systemPrompt = `You are a helpful Rutgers accessibility assistant. 
Answer the user's question using ONLY the information provided in the context below. 
If the context doesn't contain enough information, say so clearly and suggest contacting DOTS or RADR.
Keep your answer concise, clear, and friendly.

Context:
${context}`;

  const userMessage = `Question: ${topic}${campus !== 'all' ? ` (campus: ${campus})` : ''}`;

  let content;
  try {
    const response = await getResponse([{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], {});
    content = response.content;
    logger.info('OpenAI response received', { contentLength: content?.length || 0 });
  } catch (err) {
    logger.error('OpenAI getResponse failed:', err.message);
    // Fallback: show raw content embed
    const rawFields = topResults.map(r => ({
      name: r.topic || 'Info',
      value: r.content.slice(0, 900) + (r.content.length > 900 ? '...' : ''),
      inline: false
    }));
    await interaction.editReply({
      embeds: [{
        color: 0xCC0033,
        title: `♿ Accessibility — ${topic}${campus !== 'all' ? ` (${campus})` : ''}`,
        fields: rawFields,
        footer: { text: 'Sources: RADR · DOTS · ODS' },
        timestamp: new Date().toISOString()
      }]
    });
    return;
  }

  // ✨ Build the embed for the successful answer
  const embed = {
    color: 0xCC0033,
    title: `♿ Accessibility — ${topic}${campus !== 'all' ? ` (${campus})` : ''}`,
    description: content,  // main answer
    fields: [],
    footer: { text: 'Source: RADR · DOTS · ODS | Always verify directly with the office' },
    timestamp: new Date().toISOString()
  };

  // Optionally add source URLs as a field (if available)
  const sources = topResults
    .map(r => r.source_url)
    .filter(Boolean)
    .slice(0, 3);
  if (sources.length > 0) {
    embed.fields.push({
      name: '📎 Sources',
      value: sources.map((url, i) => `[Source ${i+1}](${url})`).join(' · '),
      inline: false
    });
  }

  // Check if the embed description exceeds the 6000 char limit
  if (content.length > 6000) {
    // Truncate and add a note
    embed.description = content.slice(0, 5997) + '…\n\n*(Answer truncated due to length – ask a follow‑up for more details.)*';
    // Send the embed even if truncated (it's still within limit)
    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }

  logger.info('Handled /access (RAG + OpenAI embed)', { userId, topic, campus, results: results.length });
}

// Helper fallback embed
function fallbackEmbed(topic, campus) {
  return {
    color: 0xCC0033,
    title: '♿ Accessibility Info',
    description: `I couldn't find specific accessibility information for **"${topic}"**${campus !== 'all' ? ` on the **${campus}** campus` : ''}.\n\nFor direct help:\n• **RADR:** radr.rutgers.edu\n• **DOTS:** ipo.rutgers.edu/dots | 848-932-7744\n• **Facilities (broken elevator etc):** 848-445-1234\n• **RUPD Non-Emergency:** 732-932-7211`,
    footer: { text: 'Rutgers Access and Disability Resources · radr.rutgers.edu' },
    timestamp: new Date().toISOString()
  };
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
  console.log("Autocomplete called!");

  try {
    // Only autocomplete for /parking
    if (interaction.commandName !== "parking") {
      return interaction.respond([]);
    }

    const focused = interaction.options.getFocused();

    const { data, error } = await supabase
      .from("app_rutgers_buildings")
      .select("name, campus")
      .or(
        `name.ilike.${focused}%,name.ilike.%${focused}%`
      )
      .limit(25);

    if (error) {
      logger.error("Autocomplete failed:", error.message);
      return interaction.respond([]);
    }

    await interaction.respond(
      data.map((building) => ({
        name: `${building.name} • ${building.campus.replace(
          "Rutgers University - ",
          ""
        )}`,
        value: building.name
      }))
    );
  } catch (err) {
    logger.error("Autocomplete exception:", err.message);
    return interaction.respond([]);
  }
}

module.exports = { handleInteraction,
   handleAutocomplete
};