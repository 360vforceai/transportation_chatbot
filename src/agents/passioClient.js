const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════════════════════════
// PASSIO GO INTEGRATION — Rutgers' live bus tracking provider
// Unofficial public API (no auth required), same backend the official
// Passio Go app/website hits. Endpoint shapes confirmed against the
// open-source `passiogo` Python package (github.com/athuler/PassioGo).
// Rutgers University's system ID within Passio is 1268.
// ═══════════════════════════════════════════════════════════════════════════

const BASE_URL = 'https://passiogo.com';
const SYSTEM_ID = '1268'; // Rutgers University

async function sendPassioRequest(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === null ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = await res.json();
  if (data && data.error) {
    throw new Error(`Passio API error: ${data.error}`);
  }
  return data;
}

// ─── Routes ─────────────────────────────────────────────────────────────────
// Static-ish — cache for an hour.

const ROUTES_CACHE_MS = 60 * 60 * 1000;
let _routesCache = { data: null, fetchedAt: 0 };

async function fetchRoutes() {
  const now = Date.now();
  if (_routesCache.data && (now - _routesCache.fetchedAt) < ROUTES_CACHE_MS) {
    return _routesCache.data;
  }
  try {
    const url = `${BASE_URL}/mapGetData.php?getRoutes=1`;
    const body = { systemSelected0: SYSTEM_ID, amount: 1 };
    const raw = await sendPassioRequest(url, body);
    const routesRaw = Array.isArray(raw) ? raw : (raw.all || []);

    // Filter to only routes belonging to this system (userId === SYSTEM_ID)
    // This removes routes from other Rutgers campuses that share the feed
    const routes = routesRaw
      .filter((r) => String(r.userId) === SYSTEM_ID)
      .map((r) => ({
        id: r.id,
        groupId: r.groupId,
        name: r.name,
        shortName: r.shortName,
        color: r.groupColor,
        distance: r.distance,
        serviceTime: r.serviceTimeShort || r.serviceTime || null,
        latitude: r.latitude,
        longitude: r.longitude
      }));

    logger.info('passioClient.fetchRoutes succeeded', {
      count: routes.length,
      routes: routes.map((r) => `${r.shortName}(${r.name})`)
    });
    _routesCache = { data: routes, fetchedAt: now };
    return routes;
  } catch (err) {
    logger.error('passioClient.fetchRoutes failed:', err.message);
    return _routesCache.data || [];
  }
}

// ─── Stops ──────────────────────────────────────────────────────────────────
// Static-ish — cache for an hour.
// Confirmed response shapes:
//   raw.routes = { routeId: [routeName, color, [pos, stopId, ?], ...] }
//   raw.stops  = { stopId: { stopId, name, latitude, longitude, routeId, ... } }
// Route-stop ordering comes from raw.routes (index 2+ are stop entries).
// raw.stops provides coordinates for each physical stop.

const STOPS_CACHE_MS = 60 * 60 * 1000;
let _stopsCache = { data: null, fetchedAt: 0 };

async function fetchStops() {
  const now = Date.now();
  if (_stopsCache.data && (now - _stopsCache.fetchedAt) < STOPS_CACHE_MS) {
    return _stopsCache.data;
  }
  try {
    const url = `${BASE_URL}/mapGetData.php?getStops=2`;
    const body = { s0: SYSTEM_ID, sA: 1 };
    const raw = await sendPassioRequest(url, body);

    // Build stopId -> stop detail map from raw.stops
    const stopsRaw = Array.isArray(raw.stops)
      ? Object.fromEntries(raw.stops.map((s) => [s.stopId, s]))
      : (raw.stops || {});

    // Build routeId -> ordered array of stop entries from raw.routes.
    // raw.routes[routeId] = [routeName, color, [pos, stopId, ?], ...]
    // Entries at index 2+ are stop tuples; sort by position (index 0).
    const routesAndStops = {};
    const routeNames = {};
    for (const [routeId, routeEntry] of Object.entries(raw.routes || {})) {
      routeNames[routeId] = { name: routeEntry[0], color: routeEntry[1] };
      const stopTuples = routeEntry.slice(2).filter(Array.isArray);
      stopTuples.sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      routesAndStops[routeId] = stopTuples.map((t) => String(t[1])); // ordered stopIds
    }

    // Deduplicated physical stops list for nearest-stop distance lookups
    const stops = Object.values(stopsRaw).map((s) => ({
      id: String(s.stopId),
      name: s.name,
      latitude: parseFloat(s.latitude),
      longitude: parseFloat(s.longitude)
    }));

    const result = { stops, routesAndStops, routeNames, stopsById: stopsRaw };
    _stopsCache = { data: result, fetchedAt: now };
    logger.info('passioClient.fetchStops succeeded', { count: stops.length, routes: Object.keys(routesAndStops).length });
    return result;
  } catch (err) {
    logger.error('passioClient.fetchStops failed:', err.message);
    return _stopsCache.data || { stops: [], routesAndStops: {}, routeNames: {}, stopsById: {} };
  }
}

async function getStopsForRoute(routeId) {
  const { routesAndStops, stopsById } = await fetchStops();
  const orderedIds = routesAndStops[String(routeId)] || [];
  return orderedIds.map((id) => stopsById[id]).filter(Boolean);
}

// ─── Live vehicle positions ─────────────────────────────────────────────────
// Genuinely live — short cache just to avoid hammering Passio on bursts of
// commands within the same few seconds.

const VEHICLES_CACHE_MS = 15 * 1000;
let _vehiclesCache = { data: null, fetchedAt: 0 };

async function fetchVehicles() {
  const now = Date.now();
  if (_vehiclesCache.data && (now - _vehiclesCache.fetchedAt) < VEHICLES_CACHE_MS) {
    return _vehiclesCache.data;
  }
  try {
    const url = `${BASE_URL}/mapGetData.php?getBuses=2`;
    const body = { s0: SYSTEM_ID, sA: 1 };
    const raw = await sendPassioRequest(url, body);

    const busesRaw = raw.buses || {};
    const vehicles = [];
    for (const [vehicleId, entries] of Object.entries(busesRaw)) {
      if (vehicleId === '-1') continue;
      const v = Array.isArray(entries) ? entries[0] : entries;
      if (!v) continue;
      vehicles.push({
        id: v.busId,
        name: v.busName,
        routeId: v.routeId,
        routeName: v.route,
        color: v.color,
        latitude: parseFloat(v.latitude),
        longitude: parseFloat(v.longitude),
        speed: v.speed != null ? parseFloat(v.speed) : null,
        course: v.calculatedCourse != null ? parseFloat(v.calculatedCourse) : null,
        paxLoad: v.paxLoad100 != null ? parseFloat(v.paxLoad100) : null,
        outOfService: !!v.outOfService
      });
    }

    _vehiclesCache = { data: vehicles, fetchedAt: now };
    logger.info('passioClient.fetchVehicles succeeded', { count: vehicles.length });
    return vehicles;
  } catch (err) {
    logger.error('passioClient.fetchVehicles failed:', err.message);
    return _vehiclesCache.data || [];
  }
}

async function getVehiclesForRoute(routeId) {
  const vehicles = await fetchVehicles();
  // eslint-disable-next-line eqeqeq
  return vehicles.filter((v) => v.routeId == routeId && !v.outOfService);
}

// Returns only vehicles on routes belonging to this Passio system.
// Filters out buses from other campuses that share the live feed.
async function filterNBVehicles(vehicles) {
  const routes = await fetchRoutes();
  const validRouteIds = new Set(routes.map((r) => String(r.id)));
  return vehicles.filter((v) => validRouteIds.has(String(v.routeId)) && !v.outOfService);
}

// ─── System alerts ──────────────────────────────────────────────────────────

const ALERTS_CACHE_MS = 5 * 60 * 1000;
let _alertsCache = { data: null, fetchedAt: 0 };

async function fetchSystemAlerts() {
  const now = Date.now();
  if (_alertsCache.data && (now - _alertsCache.fetchedAt) < ALERTS_CACHE_MS) {
    return _alertsCache.data;
  }
  try {
    const url = `${BASE_URL}/goServices.php?getAlertMessages=1`;
    const body = { systemSelected0: SYSTEM_ID, amount: 1, routesAmount: 0 };
    const raw = await sendPassioRequest(url, body);
    const alerts = (raw.msgs || []).map((m) => ({
      id: m.id,
      routeId: m.routeId,
      name: m.name,
      html: m.html
    }));
    _alertsCache = { data: alerts, fetchedAt: now };
    logger.info('passioClient.fetchSystemAlerts succeeded', { count: alerts.length });
    return alerts;
  } catch (err) {
    logger.error('passioClient.fetchSystemAlerts failed:', err.message);
    return _alertsCache.data || [];
  }
}

// ─── Live ETA (experimental) ────────────────────────────────────────────────
// This endpoint isn't in the reference implementation (still an open feature
// request upstream) but has been observed in the wild as a simple GET. Treat
// it as best-effort: failures should fall back to speed/distance estimates,
// never block a response.

async function fetchEta(routeId, stopIds) {
  try {
    const ids = Array.isArray(stopIds) ? stopIds.join(',') : String(stopIds);
    const url = `${BASE_URL}/mapGetData.php?eta=1&routeId=${encodeURIComponent(routeId)}&stopIds=${encodeURIComponent(ids)}&routeIds=${encodeURIComponent(routeId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    logger.warn('passioClient.fetchEta failed (non-fatal, experimental endpoint):', err.message);
    return null;
  }
}

// ─── Lookup helpers ─────────────────────────────────────────────────────────

async function findRouteByQuery(query) {
  const routes = await fetchRoutes();
  const q = query.trim().toLowerCase();

  return (
    routes.find((r) => (r.shortName || '').toLowerCase() === q) ||
    routes.find((r) => (r.name || '').toLowerCase() === q) ||
    routes.find((r) => (r.shortName || '').toLowerCase().startsWith(q)) ||
    routes.find((r) => (r.name || '').toLowerCase().startsWith(q)) ||
    (q.length >= 3 ? routes.find((r) => (r.shortName || '').toLowerCase().includes(q)) : null) ||
    (q.length >= 3 ? routes.find((r) => (r.name || '').toLowerCase().includes(q)) : null) ||
    null
  );
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearestStops(lat, lng, limit = 3) {
  const { stops, stopsById } = await fetchStops();
  return stops
    .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
    .map((s) => ({ ...s, distanceMiles: haversineMiles(lat, lng, s.latitude, s.longitude) }))
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);
}

// ─── Route schedule metadata ─────────────────────────────────────────────────
// Hours sourced from Rutgers DOTS official schedule pages.
// All times in 24h. Routes not listed here are assumed always available.
// Overnight routes only run ~3AM-6AM Mon-Thu — heavily penalize during day.

const ROUTE_SCHEDULES = {
  // Daytime intercampus routes
  'LX':       { startH: 6,  startM: 0,  endH: 3,  endM: 30, overnight: false },
  'EE':       { startH: 6,  startM: 0,  endH: 3,  endM: 30, overnight: false },
  'H':        { startH: 6,  startM: 0,  endH: 3,  endM: 30, overnight: false },
  'A':        { startH: 6,  startM: 0,  endH: 3,  endM: 30, overnight: false },
  'B':        { startH: 6,  startM: 0,  endH: 3,  endM: 30, overnight: false },
  'C':        { startH: 6,  startM: 0,  endH: 3,  endM: 30, overnight: false },
  'REXL':     { startH: 7,  startM: 0,  endH: 23, endM: 0,  overnight: false },
  'REXB':     { startH: 7,  startM: 0,  endH: 23, endM: 0,  overnight: false },
  'F':        { startH: 7,  startM: 0,  endH: 21, endM: 0,  overnight: false },
  // Overnight routes — only valid 3AM-6AM Mon-Thu
  'Overnight 1': { startH: 3, startM: 0, endH: 6, endM: 0, overnight: true },
  'Overnight 2': { startH: 3, startM: 0, endH: 6, endM: 0, overnight: true },
};

// Returns true if routeName is an overnight-only route during current hour
function isOvernightOnlyNow(routeName) {
  const schedule = ROUTE_SCHEDULES[routeName];
  if (!schedule || !schedule.overnight) return false;
  const hourNow = new Date().getHours();
  // Overnight window is 3-6AM; outside that, it shouldn't be suggested
  return hourNow >= 6 || hourNow < 3;
}

// Finds routes that connect a stop near fromBuilding to a stop near toBuilding,
// in the correct direction (fromStop appears before toStop in the route's ordered
// stop list). Returns matches sorted by score (fewer stops between = better,
// overnight routes heavily penalized during daytime).
async function findRoutesBetweenStops(fromStopIds, toStopIds) {
  const { routesAndStops, routeNames } = await fetchStops();
  const matches = [];

  for (const [routeId, orderedIds] of Object.entries(routesAndStops)) {
    fromStopIds.forEach((fromId, fromRank) => {
      const fromIdx = orderedIds.indexOf(fromId);
      if (fromIdx === -1) return;
      toStopIds.forEach((toId, toRank) => {
        const toIdx = orderedIds.indexOf(toId, fromIdx + 1);
        if (toIdx === -1) return;
        const stopsBetween = toIdx - fromIdx;
        const rn = routeNames[routeId] || {};
        const routeName = rn.name || 'Unknown route';

        // Heavily penalize overnight routes during daytime so they only win
        // when no daytime route connects the two stops at all
        const overnightPenalty = isOvernightOnlyNow(routeName) ? 1000 : 0;

        matches.push({
          routeId,
          routeName,
          routeShortName: routeName,
          fromStopId: fromId,
          toStopId: toId,
          stopsBetween,
          score: stopsBetween + fromRank * 2 + toRank * 2 + overnightPenalty
        });
      });
    });
  }

  matches.sort((a, b) => a.score - b.score);
  return matches;
}

module.exports = {
  SYSTEM_ID,
  fetchRoutes,
  fetchStops,
  getStopsForRoute,
  fetchVehicles,
  getVehiclesForRoute,
  filterNBVehicles,
  fetchSystemAlerts,
  fetchEta,
  findRouteByQuery,
  findNearestStops,
  findRoutesBetweenStops,
  haversineMiles
};