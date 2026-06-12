/**
 * Economic Calendar Sync — Google Apps Script
 * ─────────────────────────────────────────────
 * 1. Polls your Render scraper endpoint for economic events
 * 2. Creates Google Calendar events with forecast/previous in description
 * 3. Updates actual figures once the event time has passed
 *
 * SETUP:
 *  1. Create a new Google Calendar named "Economic Calendar" (or change CALENDAR_NAME below)
 *  2. Paste this entire file into Apps Script (script.google.com)
 *  3. Fill in RENDER_URL and API_SECRET below
 *  4. Run setupTriggers() once manually to register the time-based triggers
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  RENDER_URL: 'https://YOUR-APP.onrender.com',  // ← replace after Render deploy
  API_SECRET: 'YOUR_API_SECRET',                // ← copy from Render env vars
  CALENDAR_NAME: 'Economic Calendar',
  // How far ahead to sync (days). 14 = this week + next week
  SYNC_WINDOW_DAYS: 14,
  // Event colours by impact (Google Calendar colour IDs)
  COLOUR: {
    High:   '11',  // Red (Tomato)
    Medium: '5',   // Yellow (Banana)
    Low:    '8',   // Grey (Graphite)
  },
  // Country flag emojis for quick visual scanning
  FLAG: {
    USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', AUD: '🇦🇺', JPY: '🇯🇵',
  },
};

// ─── MAIN SYNC ────────────────────────────────────────────────────────────────
function syncEconomicCalendar() {
  const events = fetchEventsFromRender();
  if (!events || events.length === 0) {
    Logger.log('No events returned from scraper.');
    return;
  }

  const calendar = getOrCreateCalendar(CONFIG.CALENDAR_NAME);
  let created = 0, updated = 0, skipped = 0;

  for (const event of events) {
    const eventDate = parseEventDate(event);
    if (!eventDate) { skipped++; continue; }

    const existingEvent = findExistingCalEvent(calendar, event, eventDate);

    if (!existingEvent) {
      createCalEvent(calendar, event, eventDate);
      created++;
    } else {
      const didUpdate = updateCalEvent(existingEvent, event);
      didUpdate ? updated++ : skipped++;
    }
  }

  Logger.log(`Sync complete — created: ${created}, updated: ${updated}, skipped: ${skipped}`);
}

// ─── FETCH FROM RENDER ────────────────────────────────────────────────────────
function fetchEventsFromRender() {
  const url = `${CONFIG.RENDER_URL}/events`;
  const options = {
    method: 'GET',
    headers: { 'x-api-secret': CONFIG.API_SECRET },
    muteHttpExceptions: true,
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code !== 200) {
      Logger.log(`Render API error: HTTP ${code} — ${response.getContentText().substring(0, 200)}`);
      return null;
    }

    const json = JSON.parse(response.getContentText());
    Logger.log(`Fetched ${json.events?.length ?? 0} events (cached: ${json.cached})`);
    return json.events || [];
  } catch (e) {
    Logger.log('fetchEventsFromRender error: ' + e.message);
    return null;
  }
}

// ─── CALENDAR EVENT HELPERS ───────────────────────────────────────────────────
function createCalEvent(calendar, event, startDate) {
  const endDate = new Date(startDate.getTime() + 30 * 60 * 1000); // 30 min duration
  const title = buildTitle(event);
  const description = buildDescription(event, false);

  const calEvent = calendar.createEvent(title, startDate, endDate, {
    description,
  });

  calEvent.setColor(CONFIG.COLOUR[event.impact] ?? CONFIG.COLOUR.Low);
  // Store source ID for reliable lookups later
  calEvent.setTag('ff_title', event.title);
  calEvent.setTag('ff_country', event.country);
  calEvent.setTag('ff_date', startDate.toISOString());
}

function updateCalEvent(calEvent, event) {
  // Only update if actual has arrived and isn't already in the description
  const hasActual = event.actual && event.actual !== '' && event.actual !== '—';
  const currentDesc = calEvent.getDescription() || '';
  const actualAlreadySaved = currentDesc.includes('Actual:') &&
    !currentDesc.includes('Actual: —') &&
    !currentDesc.includes('Actual: pending');

  if (hasActual && !actualAlreadySaved) {
    calEvent.setDescription(buildDescription(event, true));
    // Change colour to grey once resolved — it's history now
    calEvent.setColor('8');
    return true;
  }

  return false;
}

function findExistingCalEvent(calendar, event, eventDate) {
  // Search ±1 hour window around the event time
  const windowStart = new Date(eventDate.getTime() - 60 * 60 * 1000);
  const windowEnd = new Date(eventDate.getTime() + 60 * 60 * 1000);

  const calEvents = calendar.getEvents(windowStart, windowEnd);

  return calEvents.find(ce => {
    return (
      ce.getTag('ff_title') === event.title &&
      ce.getTag('ff_country') === event.country
    );
  }) || null;
}

// ─── FORMATTING ───────────────────────────────────────────────────────────────
function buildTitle(event) {
  const flag = CONFIG.FLAG[event.country] ?? event.country;
  return `${flag} ${event.title}`;
}

function buildDescription(event, hasActual) {
  const lines = [
    `Country: ${event.country}`,
    `Impact: ${event.impact}`,
    `Forecast: ${event.forecast || '—'}`,
    `Previous: ${event.previous || '—'}`,
    `Actual: ${hasActual && event.actual ? event.actual : 'pending'}`,
    '',
    `Source: Forex Factory`,
  ];
  return lines.join('\n');
}

// ─── DATE PARSING ─────────────────────────────────────────────────────────────
function parseEventDate(event) {
  try {
    // JSON feed returns ISO strings like "2026-06-12T12:30:00-0400"
    if (event.date && event.date.includes('T')) {
      return new Date(event.date);
    }

    // Playwright fallback returns separate date + time strings
    // date: "Fri Jun 13" time: "8:30am"
    if (event.date && event.time) {
      const year = new Date().getFullYear();
      const combined = `${event.date} ${year} ${event.time}`;
      const parsed = new Date(combined);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    return null;
  } catch (e) {
    return null;
  }
}

// ─── CALENDAR LOOKUP ──────────────────────────────────────────────────────────
function getOrCreateCalendar(name) {
  const calendars = CalendarApp.getCalendarsByName(name);
  if (calendars.length > 0) return calendars[0];

  Logger.log(`Creating new calendar: "${name}"`);
  return CalendarApp.createCalendar(name, {
    summary: 'High-impact economic events (USD, EUR, GBP, AUD, JPY)',
    color: CalendarApp.Color.RED,
  });
}

// ─── TRIGGER SETUP (run once manually) ────────────────────────────────────────
function setupTriggers() {
  // Delete existing triggers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Sync every 4 hours — catches new events and updates actuals promptly
  ScriptApp.newTrigger('syncEconomicCalendar')
    .timeBased()
    .everyHours(4)
    .create();

  Logger.log('Trigger set: syncEconomicCalendar every 4 hours.');
}

// ─── MANUAL HELPERS ───────────────────────────────────────────────────────────

// Run this to wipe all events in the calendar (useful for testing)
function clearCalendar() {
  const calendar = getOrCreateCalendar(CONFIG.CALENDAR_NAME);
  const now = new Date();
  const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const events = calendar.getEvents(now, twoWeeksOut);
  events.forEach(e => e.deleteEvent());
  Logger.log(`Deleted ${events.length} events.`);
}

// Run this to test the Render connection
function testRenderConnection() {
  const events = fetchEventsFromRender();
  if (events) {
    Logger.log(`Connection OK — ${events.length} events`);
    events.slice(0, 3).forEach(e => Logger.log(JSON.stringify(e)));
  }
}
