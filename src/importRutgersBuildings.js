require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const URL =
  'https://services1.arcgis.com/ze0XBzU1FXj94DJq/ArcGIS/rest/services/Rutgers_University_Buildings/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json';

async function importBuildings() {
  console.log('Downloading Rutgers buildings...');

  const response = await fetch(URL);
  const data = await response.json();

  if (!data.features) {
    console.error('No features returned.');
    console.log(data);
    return;
  }

  const buildings = data.features
    .map((feature) => {
      const b = feature.attributes;

      return {
       building_number: b.BldgNum?.toString() ?? null,
        name: b.BldgName,
        address: b.BldgAddr,
        city: b.City,
        state: b.State,
        campus: b.Campus,
        district: b.District,
        latitude: b.Latitude,
        longitude: b.Longitude,
        category: b.Category,
        category_2: b.Category_2,
        category_3: b.Category_3,
        site_id: b.Site_ID,
        website: b.Website
      };
    })
   .filter((b) => b.name && b.latitude && b.longitude)

    .filter(
    (building, index, self) =>
        index === self.findIndex((b) => b.name === building.name)
    );

    console.log(`Downloaded ${buildings.length} buildings.`);

  const chunkSize = 500;

  for (let i = 0; i < buildings.length; i += chunkSize) {
    const chunk = buildings.slice(i, i + chunkSize);

    const { error } = await supabase
      .from('app_rutgers_buildings')
      .insert(chunk);

    if (error) {
      console.error(error);
      return;
    }

    console.log(
      `Imported ${Math.min(i + chunk.length, buildings.length)} / ${buildings.length}`
    );
  }

  console.log('✅ Rutgers buildings imported successfully!');

}

importBuildings().catch(console.error);