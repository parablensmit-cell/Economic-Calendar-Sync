/**
 * Economic Calendar Scraper
 * Strategy 1: Forex Factory static JSON feed (nfs.faireconomy.media)
 * Strategy 2: Investing.com calendar via Playwright
 *
 * Investing.com is used as the Playwright fallback because it renders
 * its calendar table in static HTML — no JS execution needed, faster,
 * and less bot-protected than Forex Factory's main site.
 */

const { chromium } = require('playwright');

const TARGET_COUNTRIES = ['USD', 'EUR', 'GBP', 'AUD', 'JPY'];
const TARGET_IMPACT    = ['High'];  // 'High', 'Medium', 'Low'

// ─── Strategy 1: FF JSON Feed ─────────────────────────────────────────────────
async function fetchViaJsonFeed() {
  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
  ];

  const results = [];

  for (const url of urls) {
    console.log(`[json] Fetching ${url}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':    'https://www.forexfactory.com/',
          'Accept':     'application/json',
        },
      });
      clearTimeout(timeout);

      console.log(`[json] Response status: ${res.status}`);
      if (res.status === 404) {
        console.log(`[json] Skipping ${url} — not yet published (404)`);
        continue;  // nextweek feed only goes live mid-week — skip gracefully
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      console.log(`[json] Got ${data.length} raw events from ${url}`);
      results.push(...data);
    } catch (e) {
      clearTimeout(timeout);
      throw new Error(`JSON feed failed for ${url}: ${e.message}`);
    }
  }

  const filtered = results
    .filter(e => TARGET_COUNTRIES.includes(e.country))
    .filter(e => TARGET_IMPACT.map(i => i.toLowerCase()).includes(e.impact?.toLowerCase()))
    .map(e => ({
      title:    e.title,
      country:  e.country,
      date:     e.date,
      impact:   e.impact,
      forecast: e.forecast  ?? null,
      previous: e.previous  ?? null,
      actual:   e.actual    ?? null,
      source:   'ff_json',
    }));

  console.log(`[json] After filtering: ${filtered.length} events`);
  return filtered;
}

// ─── Strategy 2: Investing.com via Playwright ─────────────────────────────────
// Investing.com economic calendar renders server-side, making it far more
// reliable to scrape than Forex Factory's JS-heavy main site.
async function fetchViaPlaywright() {
  console.log('[playwright] Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                 '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale:     'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // Block media to speed up load
    await context.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg,ico}', r => r.abort());

    const page = await context.newPage();

    // Investing.com economic calendar — filter by importance=3 (high) via URL
    const url = 'https://www.investing.com/economic-calendar/';
    console.log(`[playwright] Navigating to ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for the calendar table rows to appear
    await page.waitForSelector('#economicCalendarData tr', { timeout: 20000 });

    const events = await page.evaluate(({ countries, impacts }) => {
      // Investing.com country codes differ from FF — map them
      const countryMap = {
        'United States': 'USD',
        'Euro Zone':     'EUR',
        'United Kingdom':'GBP',
        'Australia':     'AUD',
        'Japan':         'JPY',
      };

      const impactMap = { '3': 'High', '2': 'Medium', '1': 'Low' };

      const rows = Array.from(document.querySelectorAll('#economicCalendarData tr.js-event-item'));
      const results = [];
      let currentDate = '';

      for (const row of rows) {
        // Date separator rows
        const dateRow = row.querySelector('td.theDay');
        if (dateRow) { currentDate = dateRow.textContent.trim(); continue; }

        const timeEl    = row.querySelector('td.time');
        const countryEl = row.querySelector('td.flagCur span.ceFlags');
        const impactEl  = row.querySelector('td.sentiment i');
        const eventEl   = row.querySelector('td.event a');
        const actualEl  = row.querySelector('td.act');
        const forecastEl= row.querySelector('td.fore');
        const previousEl= row.querySelector('td.prev');

        if (!countryEl || !eventEl) continue;

        // Country from title attribute on the flag span
        const countryName = countryEl.getAttribute('title') || '';
        const country = countryMap[countryName];
        if (!country || !countries.includes(country)) continue;

        // Impact from class e.g. "bull bull bull" = 3 = High
        const bullCount = (impactEl?.className?.match(/bull/g) || []).length;
        const impact = impactMap[String(bullCount)] || 'Low';
        if (!impacts.includes(impact)) continue;

        results.push({
          title:    eventEl.textContent.trim(),
          country,
          date:     currentDate,
          time:     timeEl?.textContent?.trim() || '',
          impact,
          actual:   actualEl?.textContent?.trim()   || null,
          forecast: forecastEl?.textContent?.trim() || null,
          previous: previousEl?.textContent?.trim() || null,
          source:   'investing_playwright',
        });
      }

      return results;
    }, { countries: TARGET_COUNTRIES, impacts: TARGET_IMPACT });

    console.log(`[playwright] Scraped ${events.length} events from Investing.com`);
    return events;

  } finally {
    await browser.close();
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function getEconomicEvents() {
  console.log('[scraper] Attempting Strategy 1: FF JSON feed...');
  try {
    const events = await fetchViaJsonFeed();
    if (events.length === 0) throw new Error('JSON feed returned 0 matching events');
    console.log(`[scraper] Strategy 1 succeeded: ${events.length} events`);
    return events;
  } catch (err) {
    console.warn(`[scraper] Strategy 1 failed: ${err.message}`);
    console.log('[scraper] Attempting Strategy 2: Playwright (Investing.com)...');
    const events = await fetchViaPlaywright();
    console.log(`[scraper] Strategy 2 succeeded: ${events.length} events`);
    return events;
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

module.exports = { getEconomicEvents };
