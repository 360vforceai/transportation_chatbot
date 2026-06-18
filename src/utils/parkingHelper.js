const parkingData = require('../data/parkingLots.json');

// Haversine distance in miles between two coordinate points.
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 3958.8; // earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Average walking speed ~3 mph -> minutes for a given distance in miles.
function walkMinutes(miles) {
  return Math.round((miles / 3) * 60);
}

// Case-insensitive partial match on building name.
function findBuilding(destination) {
  const query = destination.toLowerCase();
  return parkingData.buildings.find((b) => b.name.toLowerCase().includes(query)) || null;
}

// Returns nearest lots to a destination, sorted by distance.
function findNearestLots(destination, limit = 3) {
  const building = findBuilding(destination);
  if (!building) return { building: null, lots: [] };

  const lots = parkingData.lots
    .map((lot) => {
      const distance = haversineDistance(building.lat, building.lng, lot.lat, lot.lng);
      return { ...lot, distanceMiles: distance, walkMinutes: walkMinutes(distance) };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, limit);

  return { building, lots };
}

// Checks whether a permit type is valid in a lot at a given time (HH:MM, 24hr).
function checkPermitEligibility(lot, permitType, time) {
  const permitOk =
    !permitType || lot.permits.some((p) => p.toLowerCase() === permitType.toLowerCase());

  let timeOk = true;
  if (time) {
    timeOk = time >= lot.hours.start && time <= lot.hours.end;
  }

  return { eligible: permitOk && timeOk, permitOk, timeOk };
}

module.exports = { findNearestLots, checkPermitEligibility, haversineDistance, walkMinutes };