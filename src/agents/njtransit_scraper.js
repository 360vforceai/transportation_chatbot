// ═══════════════════════════════════════════════════════════════════════════
// NJ TRANSIT — DEPARTUREVISION SCRAPER
// ═══════════════════════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
const NJT_DV_BASE = 'https://www.njtransit.com/dv-to';
const NJT_CACHE_MS = 90 * 1000;
const _njtCache = new Map();

// ── Will hold the official station list (set from outside) ─────────────
let stationList = [];

/**
 * Call this once with the official trainStations array from your Apollo data.
 * @param {Array} list - array of objects with a `title` property
 */
function setStationList(list) {
  stationList = list;
}

// ── Build alias map from the list ──────────────────────────────────────
function buildStationAliases() {
  const aliasMap = {};

  // 1. Add each official station
  stationList.forEach(station => {
    const full = station.title;
    const lower = full.toLowerCase();
    aliasMap[lower] = full;

    // 2. Remove " Station" / " Rail Station" / " Transit Center"
    const withoutStation = full
      .replace(/\s+Station$/, '')
      .replace(/\s+Rail Station$/, '')
      .replace(/\s+Transit Center$/, '');
    if (withoutStation !== full) {
      aliasMap[withoutStation.toLowerCase()] = full;
    }
  });

  // 3. Manual overrides (common abbreviations)
  const manual = {
    'nb': 'New Brunswick',
    'new brunswick': 'New Brunswick',
    'new brunswick station': 'New Brunswick',
    'nyc': 'New York Penn Station',
    'ny penn': 'New York Penn Station',
    'new york': 'New York Penn Station',
    'penn station': 'New York Penn Station',
    'newark penn': 'Newark Penn Station',
    'newark penn station': 'Newark Penn Station',
    'newark': 'Newark Penn Station',
    'trenton': 'Trenton Transit Center',
    'trenton transit center': 'Trenton Transit Center',
    'princeton junction': 'Princeton Junction',
    'pj': 'Princeton Junction',
    'metropark': 'Metropark',
    'edison': 'Edison',
    'rahway': 'Rahway',
    'elizabeth': 'Elizabeth',
    'linden': 'Linden',
    'metuchen': 'Metuchen',
    'hoboken': 'Hoboken',
    'secaucus': 'Secaucus Junction',
    'hamilton': 'Hamilton',
    'aberdeen': 'Aberdeen-Matawan',
    'long branch': 'Long Branch',
    'bay head': 'Bay Head',
    '30th street': '30th Street Station Philadelphia',
    '30th street station': '30th Street Station Philadelphia',
    'philadelphia 30th street': '30th Street Station Philadelphia',
  };

  Object.entries(manual).forEach(([key, value]) => {
    aliasMap[key] = value;
  });

  return aliasMap;
}

let STATION_ALIASES = {};

/**
 * (Re)builds the alias map. Call this after setting the station list.
 */
function refreshAliases() {
  STATION_ALIASES = buildStationAliases();
}

// ── Resolve user input ──────────────────────────────────────────────────
function resolveStation(input) {
  const lower = input.toLowerCase().trim();
  return STATION_ALIASES[lower] || input.trim();
}

async function fetchNJTDepartures(stationName) {
  if (Object.keys(STATION_ALIASES).length === 0 && stationList.length > 0) {
    refreshAliases();
  }

  const resolved = resolveStation(stationName);
  const cacheKey = resolved.toLowerCase();
  const cached = _njtCache.get(cacheKey);
  const now = Date.now();

  if (cached && (now - cached.fetchedAt) < NJT_CACHE_MS) {
    return cached.data;
  }

  const graphqlUrl = 'https://www.njtransit.com/api/graphql/graphql';
  const query = `
    query TrainDepartureScreens($station: String!) {
      getTrainDepartureScreens(station: $station) {
        items {
          background
          color
          departureDate
          destination
          inlineMessage
          line
          lineAbbreviation
          status
          stops { name status time }
          track
          trainID
          capacity { sections { cars { color number } position } }
        }
        bannerMsg
        twitterAccounts { title twitter }
        fullScreenMsg
      }
    }
  `;

  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'Referer': 'https://www.njtransit.com/dv-to',
      'Origin': 'https://www.njtransit.com',
    },
    body: JSON.stringify({
      operationName: 'TrainDepartureScreens',
      query,
      variables: { station: resolved }
    })
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status}`);
  }

  const json = await response.json();

  if (json?.data?.getTrainDepartureScreens?.items) {
    const items = json.data.getTrainDepartureScreens.items;
    const departures = items.map(d => ({
      trainNumber: d.trainID || '',
      line: d.line || '',
      destination: d.destination || '',
      scheduledTime: d.departureDate || '',
      status: d.status || '',
      track: d.track || '',
    }));

    departures.forEach(d => {
      const raw = d.status.toUpperCase();
      d.isOnTime = raw.includes('ON TIME') || raw.includes('ALL ABOARD');
      d.isDelayed = raw.includes('LATE') || raw.includes('DELAY');
      d.isCancelled = raw.includes('CANCEL');
    });

    const result = { station: resolved, departures };
    _njtCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    return result;
  }

  return { station: resolved, departures: [] };
}


// ── Format embed (unchanged) ───────────────────────────────────────────
/**
 * Format NJ Transit departures into a Discord embed.
 * @param {{ station: string, departures: Array }} result
 * @param {number} [limit=8] max departures to show
 */
function formatNJTEmbed(result, limit = 8) {
  const { station, departures } = result;

  if (!departures || departures.length === 0) {
    return {
      color: 0x003B8E, // NJ Transit blue
      title: `🚆 NJ Transit — ${station}`,
      description: `No upcoming departures found for **${station}**.\n\nVerify the station name and try again, or check [NJ Transit DepartureVision](https://www.njtransit.com/dv-to) directly.`,
      footer: { text: 'NJ Transit · njtransit.com' },
      timestamp: new Date().toISOString()
    };
  }

  const shown = departures.slice(0, limit);

  const fields = shown.map(d => {
    const statusIcon = d.isCancelled ? '❌' : d.isDelayed ? '🟡' : '🟢';
    const name = `${statusIcon} ${d.scheduledTime} → ${d.destination || 'Unknown'}`;
    const details = [
      d.line ? `Line: ${d.line}` : null,
      d.track ? `Track: ${d.track}` : null,
      d.status ? `Status: ${d.status}` : null,
    ].filter(Boolean).join(' · ');

    return {
      name,
      value: details || 'No additional details',
      inline: false,
    };
  });

  const hasDelays = departures.some(d => d.isDelayed || d.isCancelled);

  return {
    color: hasDelays ? 0xFEE75C : 0x003B8E,
    title: `🚆 NJ Transit Departures — ${station}`,
    description: `Next ${shown.length} departure(s) from **${station}**. Schedules update every ~90 seconds.`,
    fields,
    footer: { text: 'NJ Transit · njtransit.com | Always verify before travel' },
    timestamp: new Date().toISOString()
  };
}

function getStationList() {
  return stationList;
}

module.exports = {
  fetchNJTDepartures,
  formatNJTEmbed,
  resolveStation,
  setStationList,
  refreshAliases,
  getStationList,
};