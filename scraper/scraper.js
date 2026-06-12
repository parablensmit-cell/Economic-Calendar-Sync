const express = require('express');
const { getEconomicEvents } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 30 * 60 * 1000;

const API_SECRET = process.env.API_SECRET || null;

function authMiddleware(req, res, next) {
  if (!API_SECRET) return next();
  const provided = req.headers['x-api-secret'] || req.query.secret;
  if (provided !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── GET /events ──────────────────────────────────────────────────────────────
app.get('/events', authMiddleware, async (req, res) => {
  try {
    const now = Date.now();
    if (cache.data && (now - cache.fetchedAt < CACHE_TTL_MS)) {
      return res.json({ ok: true, cached: true, events: cache.data });
    }
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
    cacheAge: cache.fetchedAt ? Math.round((Date.now() - cache.fetchedAt) / 1000) + 's' : 'empty',
    eventCount: cache.data?.length ?? 0,
  });
});

// ─── GET /debug — tests the JSON feed directly, no Playwright ─────────────────
// Open this in your browser to see exactly what nfs.faireconomy.media returns
app.get('/debug', async (req, res) => {
  const results = {};

  for (const week of ['thisweek', 'nextweek']) {
    const url = `https://nfs.faireconomy.media/ff_calendar_${week}.json`;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://www.forexfactory.com/',
        },
      });
      clearTimeout(t);
      const body = await r.text();
      results[week] = {
        status: r.status,
        ok: r.ok,
        bodyLength: body.length,
        preview: body.substring(0, 300),
      };
    } catch (e) {
      results[week] = { error: e.message };
    }
  }

  res.json(results);
});

app.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
