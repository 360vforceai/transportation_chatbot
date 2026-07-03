const { isRateLimited, recordRequest, getRemainingSeconds } = require('../utils/rateLimiter');
const { splitMessage } = require('../utils/messageUtils');
const { getResponse, getRouterDecision } = require('../agents/aiClient');
const { findBuilding, findNearestLots, findResidentLots, findFlexLots, checkPermitEligibility } = require('../utils/parkingHelper');
const { setStationList, fetchNJTDepartures, formatNJTEmbed, refreshAliases } = require('../agents/njtransit_scraper');
const {
  parseTime,
  resolveOrigin,
  getTravelTimes,
  subtractMinutes,
  formatTime12h,
} = require('../utils/googleMapsClient');
const {
  getShortTermHistory,
  searchLongTermMemories,
  saveMemoryAsync
} = require('../utils/memoryService');
const {
  // TODO: import data functions from transportationClient.js as they are built
  searchNJTransit,
  formatNJTransitContext,
  fetchLiveAlerts,
  getAlertsForRoadway,
  fetchPortAuthorityAlerts, 
  formatPortAuthorityEmbed,
  fetchACEAlerts, 
  formatACEEmbed,
  searchBuildings,
  formatBuildingContext,
  searchBusRoutes,
  formatBusContext,
  searchAccessibility, 
} = require('../agents/transportationClient');
const navigationHelper = require('../utils/navigationHelper');
const passioClient = require('../agents/passioClient');
const logger = require('../utils/logger');

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Prevent Discord Gateway from replaying the same interaction, avoiding duplicate processing.
const handledInteractions = new Map();

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
//location finder

async function resolveLocation(input) {
  // Try Rutgers building match first
  const building = await findBuilding(input);
  if (building) {
    return {
      name: building.name,
      latitude: building.latitude,
      longitude: building.longitude,
    };
  }

  // Fall back to geocoding for towns/addresses outside Rutgers
  const geocoded = await resolveOrigin(input, null);
  if (geocoded) {
    return {
      name: geocoded.label,
      latitude: geocoded.lat,
      longitude: geocoded.lng,
    };
  }

  return null;
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
  ] = await Promise.all([
    tables.includes('community_memory')
      ? searchLongTermMemories(keywords)
      : Promise.resolve({ memories: [], embedding: null }),
    tables.includes('bus_routes')    ? searchBusRoutes(keywords)   : Promise.resolve([]),
    tables.includes('buildings')     ? searchBuildings(keywords)   : Promise.resolve([]),
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

  const messages = [...shortTermHistory, { role: 'user', content: question }];

  const { content } = await getResponse(messages, {
    busContext,
    buildingContext,
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
      ? `Both on **${navigationHelper.campusLabel(fromB)}** campus — ${distanceMiles.toFixed(2)} mi direct.`
      : `**${navigationHelper.campusLabel(fromB)}** → **${navigationHelper.campusLabel(toB)}** — ${distanceMiles.toFixed(2)} mi direct.`,
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
    const permit = interaction.options.getString('permit');
    const time = interaction.options.getString('time') ||
      new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    const building = await findBuilding(destination);

    if (!building) {
      await interaction.editReply(
        `🅿️ I couldn't find "${destination}" in my building list yet. Try a campus student center for now (e.g. "Busch Student Center").`
      );
      return;
    }

    const { lots } = await findNearestLots(building);

    if (!lots.length) {
      await interaction.editReply(`🅿️ No lots found near **${building.name}**.`);
      return;
    }

    const lines = await Promise.all(lots.map(async (lot) => {
      const { eligible, matchedRule } = await checkPermitEligibility(lot, permit, null, time);
      let status = '✅ Open to all';
      if (permit) {
        status = eligible ? `✅ Eligible (${matchedRule})` : '❌ Not eligible';
      }
      return `**${lot.name}** (${lot.campus}) — ${lot.distanceMiles.toFixed(2)} mi, ~${lot.walkMinutes} min walk — ${status}`;
    }));

    const reply = [
      `🅿️ Nearest lots to **${building.name}**:`,
      '',
      ...lines
    ].join('\n');

    await interaction.editReply(reply);
    logger.info('Handled /parking', { userId, destination, permit, time });
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

// ── /leavenow ────────────────────────────────────────────────────────────────
// Leave-now assistant — tells the user when to leave to arrive at a destination on time.
// Data sources: bus_routes (RAG), buildings (RAG), alerts (RAG)
// Options: destination (required), arrival_time (required), from (optional — defaults to current campus)
// TODO: calculate travel time from bus routes + walking, subtract from arrival_time,
//       check alerts for delays, return recommended departure time embed.

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

//// ── /Hour Convertor ─────────────────────────────────────────────────────────────────
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  return `${hours} hour${hours > 1 ? 's' : ''} ${mins} min`;
}


// ── /compare ─────────────────────────────────────────────────────────────────
// Transportation comparison — compares bus, walking, driving, biking, and train options.
// Data sources: bus_routes (RAG), buildings (RAG), njtransit (RAG)
// Options: from (required), to (required)
// TODO: run parallel queries for bus routes and buildings, estimate travel times
//       for each mode, return a comparison embed sorted by speed.

async function handleCompare(interaction, userId, username) {

  
  const fromInput = interaction.options.getString('from');
  const toInput = interaction.options.getString('to');

  const [originLocation, destLocation] = await Promise.all([
    resolveLocation(fromInput),
    resolveLocation(toInput),
  ]);

  if (!originLocation) {
    await interaction.editReply(`⚖️ I couldn't find or locate "${fromInput}". Try a Rutgers building name or a full address/town.`);
    return;
  }
  if (!destLocation) {
    await interaction.editReply(`⚖️ I couldn't find or locate "${toInput}". Try a Rutgers building name or a full address/town.`);
    return;
  }

  const travelPromise = getTravelTimes(
    originLocation.latitude, originLocation.longitude,
    destLocation.latitude, destLocation.longitude
  );

  const trainPromise = fetchNJTDepartures(fromInput).catch((err) => {
    logger.error('handleCompare: train lookup failed', { err: err.message });
    return null;
  });

  const [{ walking, driving }, trainResult] = await Promise.all([
    travelPromise,
    trainPromise,
  ]);

  const options = [];
  if (walking !== null) options.push({ mode: 'Walk', minutes: walking, detail: formatDuration(walking) });
  if (driving !== null) options.push({ mode: 'Drive', minutes: driving, detail: formatDuration(driving) });
  if (trainResult && trainResult.departures?.length > 0) {
    const next = trainResult.departures.find(d => !d.isCancelled) || trainResult.departures[0];
    options.push({
      mode: '🚆 Train',
      minutes: null,
      detail: `Next: ${next.scheduledTime} → ${next.destination}${next.status ? ` (${next.status})` : ''}`,    });
  }

  if (options.length === 0) {
    await interaction.editReply(`⚖️ Couldn't compute any travel options between **${originLocation.name}** and **${destLocation.name}**. Please try again.`);
    return;
  }

  const timed = options.filter(o => o.minutes !== null).sort((a, b) => a.minutes - b.minutes);
  const untimed = options.filter(o => o.minutes === null);
  const sorted = [...timed, ...untimed];
  
  const lines = [                                                    // ← replace this whole block
    `⚖️**${originLocation.name} → ${destLocation.name}**`,
    '',
    ...sorted.flatMap((o, i) => [`${i === 0 ? '(Best) ' : ''}${o.mode} — ${o.detail}`, '']),
  ];

  const hasTrainOption = sorted.some(o => o.mode === '🚆 Train');
  if (!hasTrainOption) {
    lines.push('', '_💡 Tip: for train times, use the exact NJ Transit station name as "from" (e.g. "New Brunswick", "Newark Penn Station")._');
  }

  await interaction.editReply(lines.join('\n'));
  logger.info('Handled /compare', { userId, from: fromInput, to: toInput, options: sorted.length });

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
    '`/transit [station]` — NJ Transit train schedules for commuters.',
    '`/leavenow <destination> <arrival_time>` — When should you leave to arrive on time?',
    '`/compare <from> <to>` — Compare walking, driving, and train options side by side. Use an exact NJ Transit station name (e.g. "New Brunswick") as `from` to include train.',
    '`/alerts [route]` — Live bus delays, detours, construction, and road closures.',
    '`/access <topic>` — Accessible routes, entrances, and transportation.',
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
    const commandName = interaction.commandName;

    // ── Transit autocomplete ────────────────────────────────────────────────
    if (commandName === 'transit') {
      const focused = interaction.options.getFocused()?.toLowerCase().trim() || '';
      const { getStationList } = require('../agents/njtransit_scraper');
      const stations = getStationList();

      if (!stations || stations.length === 0) {
        logger.warn('Station list not loaded for autocomplete');
        return interaction.respond([]);
      }

      const matched = stations.filter(s => {
        const title = s.title.toLowerCase();
        return title.includes(focused);
      });

      const choices = matched.slice(0, 25).map(s => ({
        name: s.title,
        value: s.title,
      }));

      await interaction.respond(choices);
      return;
    }

    // ── Commands that use buildings from Supabase ──────────────────────────
    if (['parking', 'leavenow', 'compare', 'navigate', 'bus'].includes(commandName)) {
      const focused = interaction.options.getFocused().replace(/,/g, '');
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
        data.map((building) => {
          const label = `${building.name} • ${building.campus.replace("Rutgers University - ", "")}`;
          return {
            name: label.length > 100 ? label.slice(0, 97) + '...' : label,
            value: building.name.length > 100 ? building.name.slice(0, 100) : building.name,
          };
        })
      );
      return;
    }

    // For any other command, respond empty
    await interaction.respond([]);
  } catch (err) {
    logger.error("Autocomplete exception:", err.message);
    try { await interaction.respond([]); } catch (_) {}
  }
}

module.exports = { handleInteraction, handleAutocomplete };
