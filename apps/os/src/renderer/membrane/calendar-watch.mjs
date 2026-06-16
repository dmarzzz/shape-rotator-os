// ── incoming-watch ──────────────────────────────────────────────────────────
// Turns the membrane's already-parsed agenda (eventsToday / eventsUpcoming) plus
// the cohort people roster into a small, prioritised list of "incoming" cards for
// the membrane's Incoming band:
//
//   • event-soon    — a timed event starts within the proximity window (tea time)
//   • person-soon   — a cohort member arrives, or returns from an absence, soon
//   • event-new     — an event appeared that wasn't on the calendar before
//   • event-changed — an existing event's time moved
//
// Design notes:
//   - PURE except for a small localStorage "seen" ledger. computeIncoming() takes
//     nowMs as a param so it's deterministic/testable (the renderer is free to use
//     the wall clock — the Date.now() ban only covers build/bot scripts).
//   - "new"/"changed" are a DIFF against a persisted baseline. On the first ever
//     run we PRIME silently (seed the baseline, emit nothing) so shipping the
//     feature doesn't flag every existing event as new — same rule as whats-new.js.
//   - Event identity deliberately EXCLUDES the clock time: keying an event by
//     `date|slug(title)` (not its time) is what lets us tell "tea moved 14:00 →
//     15:30" (a change to the same event) apart from a brand-new event.
//   - No attendee data exists on the calendar grid, so "person-soon" is a people
//     diff off dates_start / absences[].end, NOT a per-event attendee lookup.

const SEEN_KEY = 'srwk:calwatch:seen_v1';
const SEEN_CAP = 600;

// ── THE KNOB — notification policy ───────────────────────────────────────────
// This is the one place judgement lives: how soon counts as "incoming", how far
// ahead we greet arrivals, and how many cards the band may hold. Tune to taste
// (e.g. a tighter eventSoonMinutes if the tea-time ping feels too eager, or a
// shorter personSoonDays if week-ahead arrivals feel like noise).
export const WATCH_POLICY = {
  eventSoonMinutes: 90,      // greet a timed event once it's within this many minutes of now
  eventSoonGraceMinutes: 5,  // …and keep it briefly after it starts (still "now-ish")
  personSoonDays: 7,         // greet an arrival / return within this many days
  maxCards: 6,               // hard cap on the Incoming band
};

// ── helpers ──────────────────────────────────────────────────────────────────
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
// minutes-into-day from an "HH:MM" / "HH:MM–HH:MM" label (takes the start); null
// when there's no clock time (all-day / ongoing items).
function startMinutes(t) {
  // Anchor at the start: e.time is a clean clock label ("14:00" / "14:00–14:30"),
  // so a stray HH:MM elsewhere in a title can never be mistaken for a start time.
  const m = String(t || '').match(/^\s*(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) {
  if (!s) return null;
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function friendlyDay(d, nowMs) {
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
  const off = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (off <= 0) return 'today';
  if (off === 1) return 'tomorrow';
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}
function fmtClock(min) {
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = ((h + 11) % 12) + 1, ap = h >= 12 ? 'pm' : 'am';
  return `${h12}:${String(m).padStart(2, '0')}${ap}`;
}

// ── the "seen" ledger (prime baseline + acknowledge store) ───────────────────
function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function writeSeen(set) {
  try {
    let arr = [...set];
    if (arr.length > SEEN_CAP) {
      arr = arr.slice(-SEEN_CAP);
      // Never let FIFO eviction drop the prime sentinel — losing it would
      // silently re-prime on the next load and dump every event as "new".
      if (set.has('__primed__') && !arr.includes('__primed__')) arr.unshift('__primed__');
    }
    localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
  } catch {}
}
let _seen = null;
function seen() { if (!_seen) _seen = readSeen(); return _seen; }

// Acknowledge a card (the membrane calls this on dismiss): never show this exact
// identity again. For an event-changed card the identity embeds the NEW time, so
// a *future* move re-surfaces as a fresh change.
export function acknowledgeIncoming(seenKey) {
  if (!seenKey) return;
  const s = seen();
  if (s.has(seenKey)) return;
  s.add(seenKey);
  writeSeen(s);
}

// ── event identity (today + the upcoming window) ─────────────────────────────
function eventIdentities({ eventsToday, eventsUpcoming, nowMs }) {
  const today = ymd(new Date(nowMs));
  const seenKeys = new Set();
  const out = [];
  const add = (date, e) => {
    if (!e?.title) return;
    // Recurring rituals (daily tea, multi-day spans flagged `ongoing`) collapse
    // to ONE date-agnostic identity, so they prime once and never re-fire as a
    // "new event" each day; one-off events keep their date. Deduping by key also
    // guards against two same-day same-slug rows producing a false "changed".
    const key = e.ongoing ? `r:${slug(e.title)}` : `${date}|${slug(e.title)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push({ date, title: e.title, time: e.time || '', key, recurring: !!e.ongoing });
  };
  for (const e of Array.isArray(eventsToday) ? eventsToday : []) add(today, e);
  for (const e of Array.isArray(eventsUpcoming) ? eventsUpcoming : []) { if (e?.date) add(e.date, e); }
  return out;
}

// ── diff channel: new + changed ──────────────────────────────────────────────
function diffCards(identities, nowMs) {
  const s = seen();
  // PRIME: first ever run — seed the baseline with everything currently on the
  // calendar and emit nothing, so we don't flag the whole schedule as "new".
  // Wait for real data: the membrane calls this once at mount before the agenda
  // has loaded (no identities). Priming on that empty set would make the first
  // real load look entirely new — so defer priming until events are present.
  if (!s.has('__primed__')) {
    if (!identities.length) return [];
    s.add('__primed__');
    for (const id of identities) s.add(`evt:${id.key}@${id.time || 'all-day'}`);
    writeSeen(s);
    return [];
  }
  // key → the time we last acknowledged for that event, so we can spot moves.
  const seenTimeByKey = new Map();
  for (const entry of s) {
    if (!entry.startsWith('evt:')) continue;
    const at = entry.lastIndexOf('@');
    if (at < 4) continue;
    seenTimeByKey.set(entry.slice(4, at), entry.slice(at + 1));
  }
  const cards = [];
  for (const id of identities) {
    const sig = id.time || 'all-day';
    const full = `evt:${id.key}@${sig}`;
    if (s.has(full)) continue; // already acknowledged at this time
    if (seenTimeByKey.has(id.key)) {
      const oldSig = seenTimeByKey.get(id.key);
      if (oldSig === sig) continue; // same event, same time, not yet primed key — skip
      cards.push({
        kind: 'event-changed', icon: 'swap', title: id.title,
        detail: `time changed · ${oldSig === 'all-day' ? 'all day' : oldSig} → ${sig === 'all-day' ? 'all day' : sig}`,
        nav: { mode: 'calendar' }, seenKey: full, sortAt: 1,
      });
    } else {
      const d = parseYmd(id.date) || new Date(nowMs);
      cards.push({
        kind: 'event-new', icon: 'plus', title: id.title,
        detail: `new · ${friendlyDay(d, nowMs)}${id.time ? ' · ' + id.time : ''}`,
        nav: { mode: 'calendar' }, seenKey: full, sortAt: 2,
      });
    }
  }
  return cards;
}

// ── proximity channel: event-soon (tea time) ─────────────────────────────────
function eventSoonCards({ eventsToday, nowMs }) {
  const cards = [];
  const now = new Date(nowMs);
  const midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0);
  const winMs = WATCH_POLICY.eventSoonMinutes * 60000;
  const graceMs = WATCH_POLICY.eventSoonGraceMinutes * 60000;
  for (const e of Array.isArray(eventsToday) ? eventsToday : []) {
    const min = startMinutes(e.time);
    if (min == null || !e.title) continue;
    const startMs = midnight.getTime() + min * 60000;
    const delta = startMs - nowMs;
    if (delta > winMs || delta < -graceMs) continue; // outside the "incoming" window
    const mins = Math.round(delta / 60000);
    const when = mins <= 0 ? 'now' : (mins < 60 ? `in ${mins} min` : `in ${Math.round((mins / 60) * 10) / 10} h`);
    cards.push({
      kind: 'event-soon', icon: 'clock', title: e.title,
      detail: `${fmtClock(min)} · ${when}`,
      nav: { mode: 'calendar' },
      seenKey: `soon:${ymd(now)}|${slug(e.title)}|${min}`,
      sortAt: -100000 + delta, // most imminent first, ahead of diff cards
    });
  }
  return cards;
}

// ── proximity channel: person-soon (arrivals + returns) ──────────────────────
function personSoonCards({ people, nowMs }) {
  const cards = [];
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
  const horizon = today.getTime() + WATCH_POLICY.personSoonDays * 86400000;
  const within = (d) => d && d.getTime() >= today.getTime() && d.getTime() <= horizon;
  for (const p of Array.isArray(people) ? people : []) {
    if (!p?.record_id) continue;
    const name = p.name || p.record_id;
    const start = parseYmd(p.dates_start);
    if (within(start)) {
      const tail = p.role ? ` · ${p.role}` : (p.team ? ` · ${p.team}` : '');
      cards.push({
        kind: 'person-soon', icon: 'user', title: name,
        detail: `${p.role_class === 'visiting-scholar' ? 'visiting' : 'arrives'} ${friendlyDay(start, nowMs)}${tail}`,
        recordId: p.record_id,
        seenKey: `arr:${p.record_id}|${ymd(start)}`,
        sortAt: -50000 + (start.getTime() - today.getTime()) / 60000,
      });
    }
    for (const ab of Array.isArray(p.absences) ? p.absences : []) {
      const back = parseYmd(ab?.end);
      if (within(back)) {
        cards.push({
          kind: 'person-soon', icon: 'user', title: name,
          // The hand-written note ("IC3 camp — back Monday June 8") usually
          // already says when; prefer it over a computed date that would read
          // self-contradictory next to it.
          detail: ab.note ? `back · ${ab.note}` : `back ${friendlyDay(back, nowMs)}`,
          recordId: p.record_id,
          seenKey: `arr:${p.record_id}|back|${ymd(back)}`,
          sortAt: -50000 + (back.getTime() - today.getTime()) / 60000,
        });
      }
    }
  }
  return cards;
}

// ── main ─────────────────────────────────────────────────────────────────────
// Returns { cards } — already prioritised (most imminent first) and capped.
// Cards already acknowledged (dismissed) are filtered out via the seen ledger.
export function computeIncoming({ eventsToday = [], eventsUpcoming = [], people = [], nowMs } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ids = eventIdentities({ eventsToday, eventsUpcoming, nowMs: now });
  const s = seen();
  const all = [
    ...eventSoonCards({ eventsToday, nowMs: now }),
    ...personSoonCards({ people, nowMs: now }),
    ...diffCards(ids, now),
  ].filter((c) => !s.has(c.seenKey)); // drop anything already acknowledged
  all.sort((a, b) => a.sortAt - b.sortAt);
  const cap = WATCH_POLICY.maxCards;
  if (all.length <= cap) return { cards: all };
  // Per-channel quota so a busy arrivals day can't fully bury new/changed event
  // notices (and vice-versa): reserve up to 2 diff slots, then fill by priority.
  const isDiff = (c) => c.kind === 'event-new' || c.kind === 'event-changed';
  const proximity = all.filter((c) => !isDiff(c));
  const diff = all.filter(isDiff);
  const dKeep = Math.min(diff.length, 2);
  const head = proximity.slice(0, Math.max(0, cap - dKeep));
  const tail = diff.slice(0, cap - head.length);
  return { cards: [...head, ...tail].sort((a, b) => a.sortAt - b.sortAt) };
}
