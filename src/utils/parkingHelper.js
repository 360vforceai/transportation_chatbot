const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');
const Fuse = require('fuse.js');

let supabase = null;
function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_KEY not configured');
    supabase = createClient(url, key);
  }
  return supabase;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkMinutes(miles) {
  return Math.round((miles / 3) * 60);
}

function attachDistance(building, lots) {
  return lots
    .map((lot) => {
      const distance = haversineDistance(building.latitude, building.longitude, lot.lat, lot.lng);
      return { ...lot, distanceMiles: distance, walkMinutes: walkMinutes(distance) };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

function ruleAppliesToday(rule, day) {
  if (rule.days === 'Mon-Sun') return true;
  if (rule.days === 'Mon-Fri') return !['Sat', 'Sun'].includes(day);
  return true;
}

function ruleTimeOk(rule, time) {
  if (!time) return true;
  // trim DB time to HH:MM to match bot format
  const start = rule.start_time.slice(0, 5);
  const end = rule.end_time.slice(0, 5);
  return time >= start && time <= end;
}

async function findBuilding(destination) {
  destination = (destination || '').trim();
  if (!destination) return null;

  const db = getSupabase();

  // check aliases first
  const { data: alias } = await db
    .from('app_building_aliases')
    .select('building_name')
    .ilike('alias', `%${destination}%`)
    .maybeSingle();

  if (alias) destination = alias.building_name;

  // exact match
  let { data, error } = await db
    .from('app_rutgers_buildings')
    .select('*')
    .ilike('name', destination)
    .limit(1);

  if (error) { logger.error('findBuilding exact match failed:', error.message); return null; }
  if (data?.length) return data[0];

  // partial match
  ({ data, error } = await db
    .from('app_rutgers_buildings')
    .select('*')
    .ilike('name', `%${destination}%`)
    .limit(5)); // grab 5, pick shortest name (most specific match)

  if (error) { logger.error('findBuilding partial match failed:', error.message); return null; }
  if (data?.length) {
    data.sort((a, b) => a.name.length - b.name.length);
    return data[0];
  }

  // fuzzy fallback
  const { data: buildings, error: buildingError } = await db
    .from('app_rutgers_buildings')
    .select('*');

  if (buildingError) { logger.error('Fuse search failed:', buildingError.message); return null; }

  const fuse = new Fuse(buildings, {
    keys: ['name'],
    threshold: 0.3,      // tightened from 0.4
    ignoreLocation: true,
    minMatchCharLength: 3 // bumped from 2 to reduce noise
  });

  const results = fuse.search(destination);
  if (results.length) {
    logger.info(`Fuzzy matched "${destination}" -> "${results[0].item.name}"`);
    return results[0].item;
  }

  logger.info(`No building match found for "${destination}"`);
  return null;
}

async function findNearestLots(building, limit = 3) {
   if (!building) return { building: null, lots: [] };

  const db = getSupabase();

  const { data: lots, error } = await db
    .from('app_parking_lots')
    .select('*')
    .eq('lot_type', 'commuter');

  if (error) {
    logger.error('findNearestLots failed:', error.message);
    return { building, lots: [] };
  }

  return {
    building,
    lots: attachDistance(building, lots || []).slice(0, limit)
  };
}

async function findResidentLots(building, campus, limit = 3) {
  const { data: lots, error } = await getSupabase()
    .from('app_parking_lots')
    .select('*')
    .eq('lot_type', 'resident')
    .eq('campus', campus);

  if (error) {
    logger.error('findResidentLots failed:', error.message);
    return [];
  }

  return attachDistance(building, lots || []).slice(0, limit);
}

async function findFlexLots(building, limit = 3) {
  const { data: lots, error } = await getSupabase()
    .from('app_parking_lots')
    .select('*')
    .eq('lot_type', 'commuter')
    .eq('access_type', 'flex');

  if (error) {
    logger.error('findFlexLots failed:', error.message);
    return [];
  }

  return attachDistance(building, lots || []).slice(0, limit);
}

async function checkPermitEligibility(lot, permitType, homeCampus, time) {
   if (!permitType) return { eligible: true, matchedRule: null };

  const ruleNames = permitType.toLowerCase() === 'resident'
    ? ['resident', 'residentFlex']
    : ['primary', 'flex'];

  const { data, error } = await getSupabase()
    .from('app_parking_permit_rules')
    .select('*')
    .in('permit_type', ruleNames);

  if (error) {
    logger.error('checkPermitEligibility failed:', error.message);
    return { eligible: false, matchedRule: null };
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'short' });

  for (const rule of data) {
    logger.info('rule check', {
      rule: rule.permit_type,
      lot_type_ok: rule.lot_types.includes(lot.lot_type),
      access_ok: lot.access_type,
      same_campus_only: rule.same_campus_only,
      homeCampus,
      lot_campus: lot.campus,
      today,
      time,
      timeOk: ruleTimeOk(rule, time)
    });

    if (!rule.lot_types.includes(lot.lot_type)) continue;
    if (rule.permit_type === 'primary'      && lot.access_type !== 'primary') continue;
    if (rule.permit_type === 'flex'         && lot.access_type !== 'flex') continue;
    if (rule.permit_type === 'resident'     && lot.access_type !== 'primary') continue;
    if (rule.permit_type === 'residentFlex' && lot.access_type !== 'flex') continue;
    if (rule.same_campus_only && homeCampus && homeCampus.toLowerCase() !== lot.campus.toLowerCase()) continue;
    if (rule.excluded_campuses?.includes(lot.campus)) continue;
    if (!ruleAppliesToday(rule, today)) continue;
    if (!ruleTimeOk(rule, time)) continue;
    return { eligible: true, matchedRule: rule.permit_type };
  }

  return { eligible: false, matchedRule: null };
}


module.exports = {
  findBuilding,
  findNearestLots,
  findResidentLots,
  findFlexLots,
  checkPermitEligibility,
  haversineDistance,
  walkMinutes
};