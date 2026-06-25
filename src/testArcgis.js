const url =
  'https://services1.arcgis.com/ze0XBzU1FXj94DJq/ArcGIS/rest/services/Rutgers_University_Buildings/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=false&f=json';

fetch(url)
  .then(res => res.json())
  .then(data => {
    console.log('Keys:', Object.keys(data));
    console.log('Feature count:', data.features?.length);
    console.log('First feature:', data.features?.[0]);
  })
  .catch(console.error);