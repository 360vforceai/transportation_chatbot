require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const passio = require('../agents/passioClient');
const buildingsData = require('../data/buildings.json');
const { getClient } = require('../agents/aiClient');
const logger = require('../utils/logger');

// Seeds the `bus_routes` Supabase table from live Passio Go route/stop data
// so /ask can answer questions like "does the EE run on weekends" via RAG.
// Live vehicle positions are NEVER stored here — only the static route
// topology, which is what's actually worth caching as searchable content.
// Re-run periodically (e.g. each semester) in case routes change.

function nearestCampus(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const b of buildingsData.buildings) {
    const d = passio.haversineMiles(lat, lng, b.lat, b.lng);
    if (d < bestDist) {
      bestDist = d;
      best = b.campus;
    }
  }
  // Only trust the campus match if the nearest known building is reasonably
  // close — otherwise this is an off-campus stop (e.g. downtown, a dorm
  // complex) and guessing a campus would be misleading.
  return bestDist < 0.5 ? best : null;
}

function buildContent(route, stops) {
  const stopNames = stops.map((s) => s.name).filter(Boolean);
  const campuses = [...new Set(
    stops.map((s) => nearestCampus(s.latitude, s.longitude)).filter(Boolean)
  )];

  const campusLine = campuses.length
    ? `It serves the ${campuses.join(', ')} campus${campuses.length > 1 ? 'es' : ''}.`
    : '';
  const stopsLine = stopNames.length
    ? ` Stops in order: ${stopNames.join(' → ')}.`
    : ' Stop data is not currently available for this route.';
  const scheduleLine = route.serviceTime ? ` Service notes: ${route.serviceTime}.` : '';

  return `The ${route.shortName} (${route.name}) is a Rutgers campus bus route.${campusLine ? ' ' + campusLine : ''}${stopsLine}${scheduleLine}`;
}

async function seedBusRoutes() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    logger.error('SUPABASE_URL or SUPABASE_KEY is not set');
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const openai = getClient();

  const routes = await passio.fetchRoutes();
  if (routes.length === 0) {
    logger.error('No routes returned from Passio — aborting seed so we don\'t wipe existing data for nothing.');
    process.exit(1);
  }
  logger.info(`Seeding ${routes.length} bus routes...`);

  const rows = [];
  for (const route of routes) {
    const stops = await passio.getStopsForRoute(route.id);
    const content = buildContent(route, stops);

    const embedResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: content
    });

    rows.push({
      content,
      embedding: embedResponse.data[0].embedding,
      metadata: {
        routeId: route.id,
        shortName: route.shortName,
        name: route.name,
        stopCount: stops.length
      }
    });
    logger.info(`Embedded: ${route.shortName} — ${route.name} (${stops.length} stops)`);
  }

  // Full replace — simplest correct option; route count is small (~15-20).
  const { error: deleteError } = await supabase.from('bus_routes').delete().gte('id', 0);
  if (deleteError) {
    logger.error('Failed to clear bus_routes table:', deleteError.message);
    process.exit(1);
  }

  const { error: insertError } = await supabase.from('bus_routes').insert(rows);
  if (insertError) {
    logger.error('Failed to insert bus_routes:', insertError.message);
    process.exit(1);
  }

  logger.info(`Done. Seeded ${rows.length} bus routes.`);
}

seedBusRoutes().catch((err) => {
  logger.error('seedBusRoutes failed:', err.message);
  process.exit(1);
});