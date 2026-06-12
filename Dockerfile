/**
 * Forex Factory Economic Calendar Scraper
 * Strategy 1: Try the static JSON feed (no browser needed, fast)
 * Strategy 2: Fall back to Playwright if JSON feed is blocked
 */

const { chromium } = require('playwright');

// Countries we care about (Forex Factory uses these exact names)
const TARGET_COUNTRIES = ['USD', 'EUR', 'GBP', 'AUD', 'JPY'];

// Only HIGH impact events (red on FF). Set to include medium if you want more.
const TARGET_IMPACT = ['High'];  // Options: 'High', 'Medium', 'Low'

// ─── Strategy 1: Static JSON Feed ────────────────────────────────────────────
async function fetchViaJsonFeed() {
  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
  ];

  const results = [];

  for (const url of urls) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://www.forexfactory.com/',
      },
    });

    if (!res.ok) throw new Error(`JSON feed returned ${res.status}`);
    const data = await res.json();
    results.push(...data);
  }

  return results
    .filter(e => TARGET_COUNTRIES.includes(e.country))
    .filter(e => TARGET_IMPACT.map(i => i.toLowerCase()).includes(e.impact?.toLowerCase()))
    .map(e => ({
      title: e.title,
      country: e.country,
      date: e.date,          // ISO string e.g. "2026-06-12T12:30:00-0400"
      impact: e.impact,
      forecast: e.forecast ?? null,
      previous: e.previous ?? null,
      actual: e.actual ?? null,
      url: `https://www.forexfactory.com/calendar#${slugify(e.title)}`,
      source: 'ff_json',
    }));
}

// ─── Strategy 2: Playwright Scrape ───────────────────────────────────────────
async function fetchViaPlaywright() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    const page = await context.newPage();

    // Block images/fonts to speed up load
    await page.route('**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf,svg}', r => r.abort());

    const events = [];

    for (const weekParam of ['', '?week=next']) {
      await page.goto(`https://www.forexfactory.com/calendar${weekParam}`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // Wait for calendar table
      await page.waitForSelector('table.calendar__table', { timeout: 15000 });

      const weekEvents = await page.evaluate(
        ({ countries, impacts }) => {
          const rows = Array.from(
            document.querySelectorAll('tr.calendar__row')
          );

          let currentDate = '';
          const results = [];

          for (const row of rows) {
            // Date rows set context for subsequent event rows
            const dateCell = row.querySelector('td.calendar__date span');
            if (dateCell?.textContent?.trim()) {
              currentDate = dateCell.textContent.trim();
            }

            const timeEl = row.querySelector('td.calendar__time');
            const currencyEl = row.querySelector('td.calendar__currency');
            const impactEl = row.querySelector('td.calendar__impact span');
            const eventEl = row.querySelector('td.calendar__event span');
            const actualEl = row.querySelector('td.calendar__actual');
            const forecastEl = row.querySelector('td.calendar__forecast');
            const previousEl = row.querySelector('td.calendar__previous');

            if (!currencyEl || !eventEl) continue;

            const country = currencyEl.textContent.trim();
            const impactClass = impactEl?.className ?? '';
            let impact = 'Low';
            if (impactClass.includes('high')) impact = 'High';
            else if (impactClass.includes('medium')) impact = 'Medium';

            if (!countries.includes(country)) continue;
            if (!impacts.includes(impact)) continue;

            results.push({
              title: eventEl.textContent.trim(),
              country,
              date: currentDate,
              time: timeEl?.textContent?.trim() ?? '',
              impact,
              actual: actualEl?.textContent?.trim() || null,
              forecast: forecastEl?.textContent?.trim() || null,
              previous: previousEl?.textContent?.trim() || null,
              source: 'playwright',
            });
          }

          return results;
        },
        { countries: TARGET_COUNTRIES, impacts: TARGET_IMPACT }
      );

      events.push(...weekEvents);
    }

    return events;
  } finally {
    await browser.close();
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────
async function getEconomicEvents() {
  console.log('[scraper] Trying JSON feed first...');
  try {
    const events = await fetchViaJsonFeed();
    console.log(`[scraper] JSON feed OK — ${events.length} events`);
    return events;
  } catch (err) {
    console.warn(`[scraper] JSON feed failed (${err.message}), falling back to Playwright...`);
    const events = await fetchViaPlaywright();
    console.log(`[scraper] Playwright OK — ${events.length} events`);
    return events;
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

module.exports = { getEconomicEvents };
