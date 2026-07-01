const { createClient } = require('@supabase/supabase-js');
const passio = require('../agents/passioClient');

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
  return _supabase;
}

// ─── Building lookup ────────────────────────────────────────────────────────
// Queries app_rutgers_buildings directly. Returns a normalized building object
// with the fields navigationHelper needs: name, campus, lat, lng.

async function findBuilding(query) {
  if (!query) return null;
  const q = query.trim().toLowerCase();

  const { data, error } = await getSupabase()
    .from('app_rutgers_buildings')
    .select('id, name, campus, district, address, latitude, longitude, category')
    .eq('site_id', 'NB')
    .ilike('name', `%${q}%`)
    .limit(5);

  if (error || !data || data.length === 0) return null;

  // Prefer exact match, then starts-with, then first fuzzy result
  const exact = data.find((b) => b.name.toLowerCase() === q);
  const starts = data.find((b) => b.name.toLowerCase().startsWith(q));
  const best = exact || starts || data[0];

  return {
    name: best.name,
    campus: best.campus,
    district: best.district,
    address: best.address,
    lat: parseFloat(best.latitude),
    lng: parseFloat(best.longitude),
    category: best.category
  };
}

// ─── Distance / time estimates ─────────────────────────────────────────────

function haversineMiles(lat1, lng1, lat2, lng2) {
  return passio.haversineMiles(lat1, lng1, lat2, lng2);
}

function walkMinutes(miles) {
  // ~3 mph average walking speed
  return Math.max(1, Math.round((miles / 3) * 60));
}

function driveMinutes(miles) {
  // ~18 mph average for short campus-area driving (lights, turns), plus a
  // flat buffer for finding/walking from parking — pairs well with /parking.
  const driveTime = (miles / 18) * 60;
  return Math.max(3, Math.round(driveTime + 4));
}

// Rough average speed for a campus bus including stops/traffic, used only
// when we can't derive a better estimate from a live vehicle's actual speed.
const AVG_BUS_SPEED_MPH = 12;

function busRideMinutes(miles) {
  return Math.max(2, Math.round((miles / AVG_BUS_SPEED_MPH) * 60));
}

// ─── Google Maps Directions API — real walking/driving times ───────────────
// Replaces OpenRouteService. Key set via GOOGLE_MAPS_API_KEY in .env.
// Falls back to haversine estimates if key is missing or request fails.

async function getGoogleMapsRoute(fromLat, fromLng, toLat, toLng, mode) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const params = new URLSearchParams({
      origin: `${fromLat},${fromLng}`,
      destination: `${toLat},${toLng}`,
      mode, // 'walking' or 'driving'
      key: apiKey
    });
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`
    );
    if (!res.ok) throw new Error(`Google Maps HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'OK') throw new Error(`Google Maps status: ${data.status}`);
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) throw new Error('No route leg in Google Maps response');
    return {
      distanceMiles: leg.distance.value / 1609.34, // meters -> miles
      durationMinutes: Math.round(leg.duration.value / 60) // seconds -> minutes
    };
  } catch (err) {
    logger.warn('Google Maps route failed, falling back to estimate:', err.message);
    return null;
  }
}

// ─── Bus directions (real Passio routes + live vehicles where available) ───

async function getBusOptions(fromBuilding, toBuilding) {
  const [fromStops, toStops] = await Promise.all([
    passio.findNearestStops(fromBuilding.lat, fromBuilding.lng, 3),
    passio.findNearestStops(toBuilding.lat, toBuilding.lng, 3)
  ]);

  if (fromStops.length === 0 || toStops.length === 0) {
    return { found: false, reason: 'Bus stop data is unavailable right now.' };
  }

  const fromStopIds = fromStops.map((s) => s.id);
  const toStopIds = toStops.map((s) => s.id);

  const matches = await passio.findRoutesBetweenStops(fromStopIds, toStopIds);
  if (matches.length === 0) {
    return { found: false, reason: 'No single bus route directly connects these two stops.' };
  }

  const best = matches[0];

  const boardStop = fromStops.find((s) => s.id === best.fromStopId);
  const alightStop = toStops.find((s) => s.id === best.toStopId);

  const walkToStopMin = walkMinutes(boardStop.distanceMiles);
  const walkFromStopMin = walkMinutes(alightStop.distanceMiles);

  // Apply a route factor to the straight-line ride distance — campus loops
  // travel ~60% more road distance than crow-flies between stops.
  const ROUTE_FACTOR = 1.6;
  const rideMiles = haversineMiles(boardStop.latitude, boardStop.longitude, alightStop.latitude, alightStop.longitude) * ROUTE_FACTOR;
  const rideMin = busRideMinutes(rideMiles);

  // Try to ground the wait estimate in a live vehicle's actual position/speed.
  const vehiclesOnRoute = await passio.getVehiclesForRoute(best.routeId);
  let waitMin = null;
  let liveTrackingNote = null;

  if (vehiclesOnRoute.length > 0) {
    const distancesToStop = vehiclesOnRoute.map((v) =>
      haversineMiles(v.latitude, v.longitude, boardStop.latitude, boardStop.longitude)
    );
    const nearestIdx = distancesToStop.indexOf(Math.min(...distancesToStop));
    const nearestVehicle = vehiclesOnRoute[nearestIdx];
    const distToStop = distancesToStop[nearestIdx];

    if (nearestVehicle.speed && nearestVehicle.speed > 2) {
      waitMin = Math.max(1, Math.min(30, Math.round((distToStop / nearestVehicle.speed) * 60)));
    } else {
      waitMin = Math.max(1, Math.min(30, busRideMinutes(distToStop)));
    }
    liveTrackingNote = `${vehiclesOnRoute.length} bus${vehiclesOnRoute.length > 1 ? 'es' : ''} currently tracked live on this route.`;
  } else {
    waitMin = 12;
    liveTrackingNote = 'No buses currently tracked on this route — may be off-service hours. Estimate only.';
  }

  return {
    found: true,
    routeName: best.routeName,
    routeShortName: best.routeShortName,
    boardStopName: boardStop.name === fromBuilding.name ? `${boardStop.name} (bus stop)` : boardStop.name,
    alightStopName: alightStop.name === toBuilding.name ? `${alightStop.name} (bus stop)` : alightStop.name,
    walkToStopMin,
    walkFromStopMin,
    waitMin,
    rideMin,
    totalMin: walkToStopMin + waitMin + rideMin + walkFromStopMin,
    liveTrackingNote
  };
}

// ─── Main entry point ───────────────────────────────────────────────────────

async function getDirections(fromQuery, toQuery, mode) {
  const [fromBuilding, toBuilding] = await Promise.all([
    findBuilding(fromQuery),
    findBuilding(toQuery)
  ]);

  if (!fromBuilding || !toBuilding) {
    return {
      error: true,
      missing: !fromBuilding ? fromQuery : toQuery
    };
  }

  const directMiles = haversineMiles(fromBuilding.lat, fromBuilding.lng, toBuilding.lat, toBuilding.lng);
  const sameCampus = fromBuilding.campus === toBuilding.campus;

  // Use ORS for real road-following times; fall back to haversine estimates
  // if ORS_API_KEY isn't set or the request fails.
  const [googleWalk, googleDrive] = await Promise.all([
    (mode === 'bus' || mode === 'driving') ? Promise.resolve(null) : getGoogleMapsRoute(fromBuilding.lat, fromBuilding.lng, toBuilding.lat, toBuilding.lng, 'walking'),
    (mode === 'bus' || mode === 'walking') ? Promise.resolve(null) : getGoogleMapsRoute(fromBuilding.lat, fromBuilding.lng, toBuilding.lat, toBuilding.lng, 'driving'),
  ]);

  const result = {
    error: false,
    from: fromBuilding,
    to: toBuilding,
    distanceMiles: directMiles,
    sameCampus,
    walking: {
      minutes: googleWalk ? googleWalk.durationMinutes : walkMinutes(directMiles),
      distanceMiles: googleWalk ? googleWalk.distanceMiles : directMiles,
      source: googleWalk ? 'Google Maps' : 'estimate'
    },
    driving: {
      minutes: googleDrive ? googleDrive.durationMinutes : driveMinutes(directMiles),
      distanceMiles: googleDrive ? googleDrive.distanceMiles : directMiles,
      source: googleDrive ? 'Google Maps' : 'estimate'
    },
    bus: null
  };

  if (mode === 'walking' || mode === 'driving') {
    return result; // skip the bus lookup entirely if not requested
  }

  // Suppress bus option for very short trips — taking a bus loop for under
  // 0.25 miles is never faster than walking, and produces circular routing.
  const BUS_MIN_MILES = 0.25;
  if (directMiles < BUS_MIN_MILES) {
    result.bus = { found: false, reason: `These locations are only ${(directMiles * 5280).toFixed(0)} ft apart — walking is faster than any bus.` };
    return result;
  }

  try {
    result.bus = await getBusOptions(fromBuilding, toBuilding);
  } catch (err) {
    result.bus = { found: false, reason: 'Live bus data is temporarily unavailable.' };
  }

  return result;
}

module.exports = {
  findBuilding,
  haversineMiles,
  walkMinutes,
  driveMinutes,
  busRideMinutes,
  getBusOptions,
  getDirections
};