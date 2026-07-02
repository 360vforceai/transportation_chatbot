require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getClient } = require('../agents/aiClient');
const logger = require('../utils/logger');

// Seeds embeddings into the existing `app_rutgers_buildings` Supabase table.
// The table already has all building data from the Rutgers ArcGIS dataset —
// this script just generates and writes the embedding column for RAG search.
// Only processes rows where embedding IS NULL so it's safe to re-run
// incrementally if it gets interrupted.

function buildContent(b) {
  const addressLine = b.address ? ` Address: ${b.address}, ${b.city}, ${b.state}.` : '';
  const catLine = b.category ? ` Category: ${b.category}.` : '';
  const webLine = b.website ? ` Website: ${b.website}.` : '';
  return `${b.name} is located on the ${b.campus} campus (district: ${b.district}) at Rutgers University.${addressLine}${catLine}${webLine} Coordinates: ${b.latitude}, ${b.longitude}.`;
}

async function seedBuildings() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    logger.error('SUPABASE_URL or SUPABASE_KEY is not set');
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, supabaseKey);
  const openai = getClient();

  // Fetch only NB rows without embeddings yet
  const { data: buildings, error: fetchError } = await supabase
    .from('app_rutgers_buildings')
    .select('id, name, campus, district, address, city, state, latitude, longitude, category, website')
    .eq('site_id', 'NB')
    .is('embedding', null);

  if (fetchError) {
    logger.error('Failed to fetch buildings:', fetchError.message);
    process.exit(1);
  }

  logger.info(`Found ${buildings.length} NB buildings without embeddings`);

  // Process in batches to avoid hammering OpenAI
  const BATCH = 20;
  let done = 0;

  for (let i = 0; i < buildings.length; i += BATCH) {
    const batch = buildings.slice(i, i + BATCH);

    await Promise.all(batch.map(async (b) => {
      const content = buildContent(b);
      const embedResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: content
      });
      const embedding = embedResponse.data[0].embedding;

      const { error: updateError } = await supabase
        .from('app_rutgers_buildings')
        .update({ embedding })
        .eq('id', b.id);

      if (updateError) {
        logger.error(`Failed to update embedding for ${b.name}:`, updateError.message);
      } else {
        done++;
        logger.info(`[${done}/${buildings.length}] Embedded: ${b.name}`);
      }
    }));
  }

  logger.info(`Done. Embedded ${done} buildings.`);
}

seedBuildings().catch((err) => {
  logger.error('seedBuildings failed:', err.message);
  process.exit(1);
});