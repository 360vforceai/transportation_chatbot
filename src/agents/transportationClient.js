const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const RAG_THRESHOLD = 0.4;
const RAG_COUNT = 6;

let supabase = null;

function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_KEY is not set');
    supabase = createClient(url, key);
  }
  return supabase;
}

async function getEmbedding(text) {
  const { getClient } = require('./aiClient');
  const openai = getClient();
  const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: text });
  return res.data[0].embedding;
}

// ─── Shared fetch helper ──────────────────────────────────────────────────────

async function safeFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/html, */*',
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// NJ TRANSIT / PUBLIC TRANSIT INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

async function searchNJTransit(keywords) {
  try {
    const embedding = await getEmbedding(keywords);
    const { data, error } = await getSupabase().rpc('match_njtransit', {
      query_embedding: embedding,
      match_threshold: RAG_THRESHOLD,
      match_count: RAG_COUNT
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('searchNJTransit failed:', err.message);
    return [];
  }
}

function formatNJTransitContext(results) {
  if (!results || results.length === 0) return null;
  return results.map((r) => r.content).join('\n\n');
}

async function fetchLiveNJTransit(stationOrStop) {
  logger.info('fetchLiveNJTransit not yet implemented — awaiting API key', { stationOrStop });
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILDINGS — RAG over app_rutgers_buildings (powers /ask location questions)
// ═══════════════════════════════════════════════════════════════════════════

async function searchBuildings(keywords) {
  try {
    const embedding = await getEmbedding(keywords);
    const { data, error } = await getSupabase().rpc('match_app_rutgers_buildings', {
      query_embedding: embedding,
      match_threshold: RAG_THRESHOLD,
      match_count: RAG_COUNT
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('searchBuildings failed:', err.message);
    return [];
  }
}

function formatBuildingContext(results) {
  if (!results || results.length === 0) return null;
  return results.map((r) => {
    const addr = r.address ? ` (${r.address})` : '';
    return `${r.name}${addr} — ${r.campus} campus, ${r.category || 'building'}`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// BUS ROUTES — RAG over bus_routes table (powers /ask schedule questions)
// ═══════════════════════════════════════════════════════════════════════════

async function searchBusRoutes(keywords) {
  try {
    const embedding = await getEmbedding(keywords);
    const { data, error } = await getSupabase().rpc('match_bus_routes', {
      query_embedding: embedding,
      match_threshold: RAG_THRESHOLD,
      match_count: RAG_COUNT
    });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('searchBusRoutes failed:', err.message);
    return [];
  }
}

function formatBusContext(results) {
  if (!results || results.length === 0) return null;
  return results.map((r) => r.content).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// NJTA TRAFFIC ALERTS — NJ Turnpike + Garden State Parkway
// Source: https://www.njta.gov/wp-json/njta/v1/alerts (public JSON API)
// ═══════════════════════════════════════════════════════════════════════════

const NJTA_ALERTS_URL = 'https://www.njta.gov/wp-json/njta/v1/alerts';
const ALERT_CACHE_MS = 3 * 60 * 1000;
let _njtaCache = { data: null, fetchedAt: 0 };

async function fetchLiveAlerts() {
  const now = Date.now();
  if (_njtaCache.data && (now - _njtaCache.fetchedAt) < ALERT_CACHE_MS) {
    return _njtaCache.data;
  }
  try {
    const res = await safeFetch(NJTA_ALERTS_URL);
    const data = await res.json();
    _njtaCache = { data, fetchedAt: now };
    logger.info('fetchLiveAlerts (NJTA) succeeded', {
      turnpike: data?.turnpike?.length ?? 0,
      gsp: data?.gsp?.length ?? 0
    });
    return data;
  } catch (err) {
    logger.error('fetchLiveAlerts (NJTA) failed:', err.message);
    return _njtaCache.data || { turnpike: [], gsp: [] };
  }
}

async function getAlertsForRoadway(roadway) {
  const data = await fetchLiveAlerts();
  const turnpikeAlerts = data?.turnpike || [];
  const gspAlerts = data?.gsp || [];
  if (roadway === 'turnpike') return { turnpike: turnpikeAlerts, gsp: [] };
  if (roadway === 'gsp') return { turnpike: [], gsp: gspAlerts };
  return { turnpike: turnpikeAlerts, gsp: gspAlerts };
}

// ═══════════════════════════════════════════════════════════════════════════
// PORT AUTHORITY ALERTS — Bridges, Tunnels, PATH, Bus Terminals, Airports
// Source: https://www.panynj.gov/port-authority/en/alerts.html
// ═══════════════════════════════════════════════════════════════════════════

const PANYNJ_URL = 'https://www.panynj.gov/port-authority/en/alerts.html';
const PANYNJ_CACHE_MS = 5 * 60 * 1000;
let _panynjCache = { data: null, fetchedAt: 0 };

// Shared puppeteer browser instance (reused across calls)
let _browser = null;

async function getBrowser() {
  if (!_browser) {
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return _browser;
}

async function fetchPortAuthorityAlerts() {
  const now = Date.now();
  // Use cache if fresh
  if (_panynjCache.data && (now - _panynjCache.fetchedAt) < PANYNJ_CACHE_MS) {
    return _panynjCache.data;
  }

  // First try: direct fetch (fast)
  try {
    const response = await fetch(PANYNJ_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.panynj.gov/',
      },
      redirect: 'follow',
    });

    const html = await response.text();
    if (html.length > 10000) {
      // Full page received – parse directly
      const alerts = parseAlertsFromHtml(html);
      _panynjCache = { data: alerts, fetchedAt: now };
      logger.info('fetchPortAuthorityAlerts: direct fetch succeeded', { count: alerts.length });
      return alerts;
    } else {
      logger.warn('fetchPortAuthorityAlerts: direct fetch returned short HTML, falling back to Puppeteer');
    }
  } catch (err) {
    logger.warn('fetchPortAuthorityAlerts: direct fetch failed, falling back to Puppeteer', err.message);
  }

  // Fallback: Puppeteer (renders JavaScript)
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate and wait for alerts to appear (or at least the tabs)
    await page.goto(PANYNJ_URL, { waitUntil: 'networkidle2', timeout: 15000 });

    // Wait for any .AlertDisplay_Alert_Message or .Tabs-content-item
    try {
      await page.waitForSelector('.AlertDisplay_Alert_Message, .Tabs-content-item', { timeout: 5000 });
    } catch (e) {
      logger.warn('Puppeteer: no alert elements found after wait');
    }

    const html = await page.content();
    await page.close();

    if (html.length < 10000) {
      logger.warn('Puppeteer also returned short HTML, giving up');
      return _panynjCache.data || [];
    }

    const alerts = parseAlertsFromHtml(html);
    _panynjCache = { data: alerts, fetchedAt: now };
    logger.info('fetchPortAuthorityAlerts: Puppeteer succeeded', { count: alerts.length });
    return alerts;
  } catch (err) {
    logger.error('fetchPortAuthorityAlerts: Puppeteer failed', err.message);
    return _panynjCache.data || [];
  }
}

// Helper to parse alerts from HTML string
function parseAlertsFromHtml(html) {
  const $ = cheerio.load(html);
  const alerts = [];

  $('.AlertDisplay_Alert_Message').each((i, msgDiv) => {
    const raw = $(msgDiv).text().trim();
    if (!raw || raw === 'There currently are no alerts') return;

    const timestamp = $(msgDiv).find('.AlertDisplay_Alert_Message-timestamp').text().trim() || null;
    let message = raw;
    if (timestamp) {
      message = raw.replace(timestamp, '').trim();
    }

    const tab = $(msgDiv).closest('.Tabs-content-item');
    const category = tab.length
      ? tab.find('.Tab-label span').text().trim() || 'General'
      : 'Unknown';

    alerts.push({ category, message, timestamp });
  });

  return alerts;
}

function formatPortAuthorityEmbed(alerts) {
  if (!alerts || alerts.length === 0) {
    return {
      color: 0x57F287,
      title: '✅ Port Authority — No Active Alerts',
      description: 'No alerts currently reported across Port Authority facilities.',
      footer: { text: 'Live data · panynj.gov' },
      timestamp: new Date().toISOString()
    };
  }

  const fields = alerts.slice(0, 10).map(a => ({
    name: `📢 ${a.category}${a.timestamp ? ` — ${a.timestamp}` : ''}`,
    value: a.message.length > 200 ? a.message.slice(0, 197) + '...' : a.message,
    inline: false
  }));

  return {
    color: 0xFEE75C,
    title: `⚠️ Port Authority Alerts (${alerts.length} active)`,
    fields,
    footer: { text: 'Live data · panynj.gov' },
    timestamp: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ATLANTIC CITY EXPRESSWAY ALERTS
// Source: https://www.sjta.com/travel_alerts (South Jersey Transportation Authority)
// ═══════════════════════════════════════════════════════════════════════════

const SJTA_URL = 'https://www.sjta.com/travel_alerts';
const SJTA_CACHE_MS = 10 * 60 * 1000; // 10 min — updates infrequently
let _sjtaCache = { data: null, fetchedAt: 0 };

async function fetchACEAlerts() {
  const now = Date.now();
  if (_sjtaCache.data && (now - _sjtaCache.fetchedAt) < SJTA_CACHE_MS) {
    return _sjtaCache.data;
  }

  try {
    const res = await safeFetch(SJTA_URL, { headers: { 'Accept': 'text/html' } });
    const html = await res.text();
    const $ = cheerio.load(html);

    // The alert content is inside a div with id="1334165989"
    const alertDiv = $('#1334165989');
    if (!alertDiv.length) {
      throw new Error('Alert content div not found');
    }

    // Get all paragraph text (excluding child elements with strong tags, we keep them for dates)
    const lines = alertDiv.find('p').map((i, el) => $(el).text().trim()).get();
    // Also get text from any span inside (if present)
    // But the structure is simple paragraphs

    const datePattern = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
    const entries = [];
    let current = null;

    for (const line of lines) {
      if (datePattern.test(line)) {
        if (current) entries.push(current);
        current = { date: line, restrictions: [] };
      } else if (current && line && line !== '.') {
        current.restrictions.push(line);
      }
    }
    if (current) entries.push(current);

    // Filter only today and future (optional, but we keep all)
    const today = new Date();
    const filtered = entries.filter(e => {
      const parts = e.date.split('/');
      const d = new Date(
        parseInt(parts[2]) < 100 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]),
        parseInt(parts[0]) - 1,
        parseInt(parts[1])
      );
      return d >= new Date(today.getFullYear(), today.getMonth(), today.getDate());
    });

    _sjtaCache = { data: filtered, fetchedAt: now };
    logger.info('fetchACEAlerts succeeded', { entries: filtered.length });
    return filtered;
  } catch (err) {
    logger.error('fetchACEAlerts failed:', err.message);
    return _sjtaCache.data || [];
  }
}

function formatACEEmbed(entries) {
  if (!entries || entries.length === 0) {
    return {
      color: 0x57F287,
      title: '✅ Atlantic City Expressway — No Upcoming Restrictions',
      description: 'No scheduled lane restrictions at this time.',
      footer: { text: 'South Jersey Transportation Authority · sjta.com' },
      timestamp: new Date().toISOString()
    };
  }

  const fields = entries.slice(0, 5).map(e => ({
    name: `📅 ${e.date}`,
    value: e.restrictions.slice(0, 6).join('\n') || 'No details',
    inline: false
  }));

  return {
    color: 0xFFA500,
    title: `🛣️ Atlantic City Expressway — Upcoming Restrictions`,
    description: `${entries.length} date(s) with scheduled work.`,
    fields,
    footer: { text: 'South Jersey Transportation Authority · sjta.com' },
    timestamp: new Date().toISOString()
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED ALERTS COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAllAlerts() {
  const [njta, panynj, ace] = await Promise.allSettled([
    fetchLiveAlerts(),
    fetchPortAuthorityAlerts(),
    fetchACEAlerts()
  ]);

  return {
    njta: njta.status === 'fulfilled' ? njta.value : { turnpike: [], gsp: [] },
    panynj: panynj.status === 'fulfilled' ? panynj.value : [],
    ace: ace.status === 'fulfilled' ? ace.value : [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCESSIBILITY
// ═══════════════════════════════════════════════════════════════════════════

async function searchAccessibility(query, campus = null) {
  try {
    // 1. Embed the query
    const embedding = await getEmbedding(query);

    // 2. Call the vector search function
    const { data, error } = await getSupabase().rpc('match_accessibility', {
      query_embedding: embedding,
      match_threshold: 0.4,      // was 0.7 – much more permissive
      match_count: 10            // was 5 – get more candidates
    });
    if (error) throw error;

    // 3. Optional campus filter (keep 'all' records too)
    if (campus && campus !== 'all') {
      return data.filter(r => r.campus === campus || r.campus === 'all');
    }
    return data || [];
  } catch (err) {
    logger.error('searchAccessibility failed:', err.message);
    return [];
  }
}

function formatAccessibilityContext(results) {
  if (!results || results.length === 0) return null;
  return results.map((r) => r.content).join('\n\n');
}

async function getAccessibilityInfo(buildingName) {
  try {
    const { data, error } = await getSupabase()
      .from('accessibility')
      .select('*')
      .ilike('building', `%${buildingName.trim()}%`)
      .limit(1)
      .single();
    if (error || !data) return null;
    return data;
  } catch (err) {
    logger.error('getAccessibilityInfo failed:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  searchNJTransit,
  formatNJTransitContext,
  fetchLiveNJTransit,
  fetchLiveAlerts,
  getAlertsForRoadway,
  fetchPortAuthorityAlerts,
  formatPortAuthorityEmbed,
  fetchACEAlerts,
  formatACEEmbed,
  fetchAllAlerts,
  searchAccessibility,
  formatAccessibilityContext,
  getAccessibilityInfo,
  searchBuildings,
  formatBuildingContext,
  searchBusRoutes,
  formatBusContext,
};