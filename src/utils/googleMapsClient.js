const logger = require('./logger');

const CAMPUS_COORDS = {
  'Busch':       { lat: 40.5220, lng: -74.4636 },
  'Livingston':  { lat: 40.5243, lng: -74.4347 },
  'College Ave': { lat: 40.4988, lng: -74.4478 },
  'Cook':        { lat: 40.4836, lng: -74.4321 },
  'Douglass':    { lat: 40.4836, lng: -74.4321 }
};

// parse arrival time string into 24h "HH:MM"
function parseTime(str) {
  if (!str) return null;
  str = str.trim().toLowerCase();

  // already 24h e.g. "14:30"
  if (/^\d{1,2}:\d{2}$/.test(str)) return str.padStart(5, '0');

  // 12h e.g. "2:30pm", "9:00am"
  const match = str.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)$/);
  if (!match) return null;

  let hours = parseInt(match[1]);
  const mins = match[2] || '00';
  const period = match[3];

  if (period === 'pm' && hours !== 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  return `${String(hours).padStart(2, '0')}:${mins}`;
}

// get origin coords — from address string or campus fallback
async function resolveOrigin(from, homeCampus) {
  if (homeCampus && !from) {
    const coords = CAMPUS_COORDS[homeCampus];
    if (coords) return { ...coords, label: `${homeCampus} Campus` };
  }

  if (from) {
    // geocode the address
    const query = encodeURIComponent(`${from}, New Jersey`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_KEY}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.results.length) {
      logger.error('Geocoding failed:', data.status);
      return null;
    }

    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng, label: data.results[0].formatted_address };
  }

  return null;
}

// call Distance Matrix API for walking + driving
async function getTravelTimes(originLat, originLng, destLat, destLng) {
  const origin = `${originLat},${originLng}`;
  const destination = `${destLat},${destLng}`;
  const key = process.env.GOOGLE_MAPS_KEY;

  const [walkRes, driveRes] = await Promise.all([
    fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&mode=walking&key=${key}`),
    fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&mode=driving&key=${key}`)
  ]);

  const [walkData, driveData] = await Promise.all([walkRes.json(), driveRes.json()]);

  console.log('walk API response:', JSON.stringify(walkData));
  console.log('drive API response:', JSON.stringify(driveData));

  const walkEl = walkData.rows?.[0]?.elements?.[0];
  const driveEl = driveData.rows?.[0]?.elements?.[0];

  return {
    walking: walkEl?.status === 'OK' ? Math.ceil(walkEl.duration.value / 60) : null,
    driving: driveEl?.status === 'OK' ? Math.ceil(driveEl.duration.value / 60) : null
  };
}

// subtract minutes from HH:MM time string
function subtractMinutes(time, mins) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m - mins;
  const rh = Math.floor(((total % 1440) + 1440) % 1440 / 60);
  const rm = ((total % 1440) + 1440) % 1440 % 60;
  return `${String(rh).padStart(2, '0')}:${String(rm).padStart(2, '0')}`;
}

// format HH:MM to 12h display
function formatTime12h(time) {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

module.exports = {
  parseTime,
  resolveOrigin,
  getTravelTimes,
  subtractMinutes,
  formatTime12h,
  CAMPUS_COORDS
};