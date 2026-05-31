// event-notifier.js — fires a native OS notification ~5 minutes before each
// calendar event starts. Runs app-wide (auto-started on import from boot.js),
// gated on the `notifications.enabled` preference. Reads events from
// cohort-source and shows them via api.notify (the native plugin bridge).
//
// Preference shape (stored in the single prefs blob via api.loadPrefs/savePrefs):
//   { "notifications": { "enabled": true } }
import { getCohortSurface, subscribeToCohortChanges } from "./cohort-source.js";

const LEAD_MS = 5 * 60 * 1000; // notify when an event is <= 5 minutes away
const TICK_MS = 30 * 1000; // re-check cadence

let started = false;
let timer = null;
let enabled = false;
const fired = new Set(); // event ids already notified this session
const extraEvents = []; // synthetic events injected for the self-test

function api() {
  return window.api || {};
}

// Cohort event records carry their start under a few historical field names;
// alchemy.js parses the same set. Times may be ISO strings or epoch ms.
function eventStartMs(ev) {
  if (typeof ev.startMs === "number") return ev.startMs;
  const t = Date.parse(ev.starts_at || ev.start || ev.date || ev.range_start || "");
  return Number.isFinite(t) ? t : NaN;
}

async function currentEvents() {
  let events = [];
  try {
    const surface = await getCohortSurface();
    if (surface && Array.isArray(surface.events)) events = surface.events;
  } catch (_) {}
  return extraEvents.length ? events.concat(extraEvents) : events;
}

async function check() {
  if (!enabled) return;
  const now = Date.now();
  const events = await currentEvents();
  for (const ev of events) {
    const start = eventStartMs(ev);
    if (!Number.isFinite(start)) continue;
    const delta = start - now;
    // Fire once as the event enters the [now, now+5min] window. Skip past events.
    if (delta <= 0 || delta > LEAD_MS) continue;
    const id = ev.record_id || ev.id || `${ev.title || ev.name}@${start}`;
    if (fired.has(id)) continue;
    fired.add(id);
    const mins = Math.max(1, Math.round(delta / 60000));
    const title = ev.title || ev.name || "Calendar event";
    try {
      await api().notify?.({
        title: `Starting soon: ${title}`,
        body: ev.location ? `In ${mins} min · ${ev.location}` : `Starts in ${mins} min`,
      });
      console.log("[event-notifier] notified for", id);
    } catch (err) {
      console.error("[event-notifier] notify failed", err);
    }
  }
}

async function loadPrefsAndEnabled() {
  try {
    const p = (await api().loadPrefs?.()) || {};
    enabled = !!(p && p.notifications && p.notifications.enabled === true);
    return p;
  } catch (_) {
    enabled = false;
    return {};
  }
}

// Re-read the pref and run an immediate check. Called by Settings on toggle.
export async function refresh() {
  await loadPrefsAndEnabled();
  await check();
  return enabled;
}

export function isEnabled() {
  return enabled;
}

export async function start() {
  if (started) return;
  started = true;
  const prefs = await loadPrefsAndEnabled();

  // Optional self-test: with prefs.notifications.__selftest === true, force
  // notifications on, request permission, seed a synthetic event ~1 min out,
  // and check immediately — used to verify native notifications on macOS
  // without waiting for a real calendar event. Set it by writing the prefs
  // file before launch; it is never written by the Settings UI.
  if (prefs && prefs.notifications && prefs.notifications.__selftest === true) {
    try {
      await api().notifyRequestPermission?.();
    } catch (_) {}
    enabled = true;
    extraEvents.push({
      id: "selftest-event",
      title: "Self-test event",
      start: new Date(Date.now() + 60 * 1000).toISOString(),
      location: "macOS notification check",
    });
    console.log("[event-notifier] self-test armed");
  }

  timer = setInterval(check, TICK_MS);
  setTimeout(check, 3000); // initial check once cohort data has had a moment to load
  try {
    subscribeToCohortChanges(() => check());
  } catch (_) {}
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Auto-start on import. api-shim.js is injected as the first script in
// index.html, so window.api already exists when this module evaluates.
start();
