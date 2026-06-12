/**
 * Economic Calendar API Server
 * Deployed on Render — exposes scraped FF events as JSON
 * Apps Script polls this endpoint to sync Google Calendar
 */

const express = require('express');
const { getEconomicEvents } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory cache — re-scrape at most every 30 mins
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 30 * 60 * 1000;

// Optional: protect with a shared secret so only your Apps Script can call it
const API_SECRET = process.env.API_SECRET || null;

function authMiddleware(req, res, next) {
  if (!API_SECRET) return next();
  const provided = req.headers['x-api-secret'] || req.query.secret;
  if (provided !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── GET /events ──────────────────────────────────────────────────────────────
// Returns filtered, structured economic events for this week + next
app.get('/events', authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    const cacheStale = now - cache.fetchedAt > CACHE_TTL_MS;

    if (cache.data && !cacheStale) {
      console.log('[api] Serving from cache');
      return res.json({ ok: true, cached: true, events: cache.data });
    }

    console.log('[api] Cache miss — scraping...');
    const events = await getEconomicEvents();

    cache = { data: events, fetchedAt: now };
    res.json({ ok: true, cached: false, events });
  } catch (err) {
    console.error('[api] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    cacheAge: cache.fetchedAt
      ? Math.round((Date.now() - cache.fetchedAt) / 1000) + 's'
      : 'empty',
    eventCount: cache.data?.length ?? 0,
  });
});

app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);
});
