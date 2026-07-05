import { createMembraneScene, CUBE_SCALE, MEMBRANE_FOV, MEMBRANE_CAMERA_Z } from './scene.js';
// NOTE: rubiks.js (+ its vendored GLTFLoader / cube-solver / postprocessing tree)
// is imported DYNAMICALLY in ensureRubiks(), NOT statically here. A static import
// would pull that whole subtree into boot.js's eager module graph, evaluated
// before boot() runs — keeping the easter egg off the boot critical path.
import { SHAPE_NAMES, TARGET_R } from './cube.js';

// World edge-length of the die's d6 (the cube shape the easter egg replaces):
// a unit BoxGeometry normalized to bounding-sphere TARGET_R, then group-scaled.
// The Rubik's cube body is matched to this — then bumped 20% larger by request.
const DIE_CUBE_EDGE = TARGET_R * (2 / Math.sqrt(3)) * CUBE_SCALE * 1.2;
import {
  askIsOpen, askIntent, askJoinedBy, askTopic, resolveAskAuthor,
} from '../asks.js';
import { computeIncoming, acknowledgeIncoming } from './calendar-watch.mjs';
import { submitFeedback, FEEDBACK_MIN_LENGTH, FEEDBACK_MAX_LENGTH } from '../supabase-feedback.mjs';

// Headless smoke-test boot tracing (gated on ?smoke=1; no-op for real launches).
// Mirrors boot.js cp(): pinpoints whether the deferred membrane mount blocks.
const __SMOKE = (() => { try { return new URLSearchParams(location.search).has('smoke'); } catch { return false; } })();
const cp = (label) => {
  try { window.api?.smokeTrace?.(label); } catch {}
  if (__SMOKE) { try { console.error('[smoke-cp] ' + label); } catch {} }
};

function up(s) { return String(s ?? '').toUpperCase(); }

// Remembered die shape, module-scoped so it survives leaving + returning to the
// membrane page (the scene is destroyed/re-mounted but this module stays loaded).
// Restored as the die's starting shape on mount; updated on every morph. The
// Rubik's cube is deliberately NOT persisted — leaving and coming back drops back
// to the shapes (a fresh scene), which is the only way to reset the cube.
let savedFaces = null;

// ── dismissable ambient notifications ──────────────────────────────────────
// The left feed and right agenda are peripheral notification rails. Each card
// carries a quiet dismiss control (hidden at rest, revealed on hover/focus —
// see .mfeed-dismiss / .magenda-dismiss in membrane.css). A dismissed card is
// remembered by a stable per-occurrence key so it stays gone across the
// once-a-minute / on-data re-renders. Occurrence keys embed the item's date,
// so dismissing one calendar instance never suppresses a future recurrence.
//
// Storage is SESSION-scoped on purpose: dismissals reset on the next app
// launch rather than being permanent. We're not committing to "gone forever"
// until we've seen how the affordance gets used — flip the `kind` arg to
// 'local' (below) to make dismissals persist across relaunches.
const DISMISS_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

// Calendar-plus glyph for the right-rail "add to calendar" control (Lucide,
// same family as the feed icons). Tinted by the card's --c2-acc in CSS.
const CAL_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M10 16h4"/></svg>';

// Total close-animation budget (ms) — matches the membrane fold-recede in
// membrane.css (.is-dismissing). The card is removed only after it has fully
// receded into the field, so the dissolve never snaps.
const DISMISS_MS = 460;

function makeDismissStore(key, kind = 'session') {
  // Resolve the backing Storage lazily + defensively — sessionStorage can be
  // absent/blocked; on failure the Set just lives in memory (still resets on
  // reload, which is the session-scoped behavior we want anyway).
  const store = () => {
    try { return kind === 'local' ? localStorage : sessionStorage; } catch { return null; }
  };
  let set = new Set();
  try {
    const s = store();
    const raw = s && s.getItem(key);
    if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) set = new Set(arr); }
  } catch {}
  return {
    has: (k) => set.has(k),
    add(k) {
      if (!k || set.has(k)) return;
      set.add(k);
      // Cap the ledger so a long session can't grow it unbounded; keep the
      // most-recent dismissals (newest pushed last).
      if (set.size > 400) set = new Set([...set].slice(-400));
      try { const s = store(); if (s) s.setItem(key, JSON.stringify([...set])); } catch {}
    },
  };
}

// Fold a card out — it recedes into the field like the membrane panel does
// (perspective + rotateY, the membrane's signature exit), direction set in CSS
// by the host rail. The element is REMOVED once it has receded, then `done`
// re-renders to reconcile (tail-taper, day groups). Honors reduced-motion by
// collapsing the wait to a tick. Exit styles live on the `.is-dismissing`
// class. Removing-then-rendering also lets renderFeed/renderAgenda skip a
// rebuild while any card is mid-recede (so the fold is never snapped).
// Source-of-truth reduced-motion check: the in-app toggle (data-reduce-motion
// on <html>, what motion.js/ux.js read) OR the OS-level media query.
function prefersReducedMotion() {
  try {
    if (document.documentElement.getAttribute('data-reduce-motion') === '1') return true;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

// After a notification stream re-renders (the render path replaces innerHTML
// wholesale), slide in ONLY the rows whose stable data-row-key wasn't present
// last pass — so the once-a-minute rebuild doesn't re-animate the whole
// stream. Returns the new key set to store for next time. prevKeys === null
// (first render after mount / switching into the membrane) marks nothing: the
// surface populates instantly on entry, and only cards that arrive WHILE you
// are watching animate in. Honors reduced-motion.
function markEnteringRows(rootEl, prevKeys, selector) {
  if (!rootEl) return prevKeys;
  const current = new Set();
  const reduce = prefersReducedMotion();
  rootEl.querySelectorAll(`${selector}[data-row-key]`).forEach((row) => {
    const k = row.getAttribute('data-row-key');
    if (k == null) return;
    current.add(k);
    if (prevKeys && !reduce && !prevKeys.has(k)) row.classList.add('is-entering');
  });
  // Never promote null → empty: if we've never tracked cards and still see
  // none (data not loaded yet), stay in the "first render" state so the
  // eventual first population is instant, not a stagger-storm.
  if (prevKeys === null && current.size === 0) return null;
  return current;
}

function dismissCard(el, done) {
  if (!el) { done?.(); return; }
  let reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {}
  el.classList.add('is-dismissing');
  el.style.pointerEvents = 'none';
  setTimeout(() => { try { el.remove(); } catch {} done?.(); }, reduce ? 0 : DISMISS_MS);
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const WD = ['sun','mon','tue','wed','thu','fri','sat'];
const MO = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// Minutes-into-day from an "HH:MM" (or "HH:MM–HH:MM", takes the start) label.
// null if there's no clock time (all-day / ongoing items).
function parseDayMinutes(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function pad2(n) { return String(n).padStart(2, '0'); }

// Lightweight event categoriser — mirrors the full calendar's c2Category
// (calendar.js) so the ambient agenda cards color-code off the SAME palette
// as the calendar tab. Returns a category key (or 'default'); the actual
// color lives in membrane.css's [data-cat] rules (hexes lifted from
// calendar.css). Kept local + minimal rather than importing the calendar
// module, which carries its whole sheet-parsing surface.
const AGENDA_CATS = [
  ['review',  /demo review|product review|internal .*review/i],
  ['demo',    /demo night|showcase|demo day/i],
  ['oh',      /office hour|pmf check|\bcheck[ -]?point|\b1:1/i],
  ['salon',   /salon/i],
  ['weekly',  /\bweekly\b|what did you do/i],
  ['coord',   /coordinat|attribution/i],
  ['hack',    /\bhack|hackathon|open jam|\bfinals\b|submission|build night/i],
  ['anarchy', /anarchy|self-organ|no .*program|protected build|team-led/i],
];
function agendaCat(title) {
  const t = String(title || '');
  for (const [key, re] of AGENDA_CATS) if (re.test(t)) return key;
  return 'default';
}

// Per-kind icon for "what's new" feed items so the type reads at a glance.
// Lucide (same set the rail/tabs use): github / git-commit / file-text /
// message-circle / calendar. Colored via the kind's --mfeed-color (muted tint)
// in CSS.
const LUCIDE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const FEED_ICON_PATHS = {
  release: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  transcript: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  ask: '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  event: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  // incoming-watch glyphs (keyed by card.icon): clock / user / calendar-plus /
  // refresh-cw — for event-soon, person-soon, event-new, event-changed.
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  plus: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M10 16h4"/>',
  swap: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
};
function feedIcon(kind) {
  const p = FEED_ICON_PATHS[kind];
  return p ? `<span class="mfeed-icon">${LUCIDE_OPEN}${p}</svg></span>` : '';
}

// Per-kind action verb for the left-feed hover layer — names what a click will
// do (the third interaction layer: glance → hover reveals destination → click
// commits). Terse; the arrow is appended in the row markup.
const FEED_CTA = {
  release: 'open release', commit: 'open activity', ask: 'open ask',
  event: 'open calendar', transcript: 'open readout',
  'event-soon': 'open calendar', 'event-new': 'open calendar',
  'event-changed': 'open calendar', 'person-soon': 'open profile',
};
function feedCta(kind) { return FEED_CTA[kind] || 'open'; }

// ── hub prototype: the field feed + say/did/maybe capture bar ──────────────
// The membrane's center stops being pure decoration: a "cohort today" feed
// floats over the (dimmed) die, and a capture bar sits at the bottom. Three
// verbs, one input, zero navigation. say → an ask on the spine; maybe → a
// tentative come_join; did → a self-report (feeds the mirror/attribution
// direction). v0 posts are LOCAL-ONLY (localStorage) — the spine write goes
// in with the asks migration; the point here is the interaction shape.
// Tint/ink pairs follow the asks.js intent-color pattern (colors live in JS,
// applied as inline CSS vars): say = ask amber, maybe = come_join green,
// did = a new slate-lavender (no existing intent to borrow).
const FIELD_VERBS = {
  say:   { label: 'say',   ink: '#5E4310', tint: '#EADBA8', hint: 'say it to the cohort' },
  did:   { label: 'did',   ink: '#2E3660', tint: '#CDD3EC', hint: 'log what you did' },
  maybe: { label: 'maybe', ink: '#1E4A2A', tint: '#CAE3C8', hint: 'float a plan — who’s in?' },
};
const FIELD_VERB_ORDER = ['say', 'did', 'maybe'];
const FIELD_POSTS_KEY = 'srwk:membrane:posts_v0';

function loadFieldPosts() {
  try {
    const arr = JSON.parse(localStorage.getItem(FIELD_POSTS_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    // Sanitize ts at the load boundary: a junk/legacy ts would otherwise
    // reach new Date(p.ts).toISOString() in renderFeed and THROW, killing
    // the whole left rail on every render until the key is hand-cleared.
    return arr.filter((p) => p && p.text).map((p) => ({
      ...p,
      ts: Number.isFinite(Number(p.ts)) ? Number(p.ts) : 0,
    }));
  } catch { return []; }
}
function saveFieldPosts(posts) {
  try { localStorage.setItem(FIELD_POSTS_KEY, JSON.stringify(posts.slice(-50))); } catch {}
}

// Minute-level age for the field feed — local posts are fresher than the
// day-granular feedAge() can express ("now", "12m", "3h", then days/weeks).
function fieldAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h`;
  const days = Math.floor(d / 86400e3);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// Build a Google Calendar "add event" template URL from an agenda item. The
// app's shell:openExternal is hard-restricted to http(s) (main.js), so a
// calendar.google.com TEMPLATE link is the one-click path — a data: .ics URL
// would be rejected there. dateStr is 'YYYY-MM-DD'; timeLabel is the agenda
// clock label ("19:00", "19:00–20:00", "all day", or empty).
function gcalDateRange(dateStr, timeLabel) {
  const ymd = String(dateStr || '').slice(0, 10).replace(/-/g, '');
  if (!/^\d{8}$/.test(ymd)) return null;
  const times = String(timeLabel || '').match(/\d{1,2}:\d{2}/g) || [];
  if (!times.length) {
    // All-day: Google wants an exclusive end date (the following day).
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    const nd = new Date(d.getTime() + 86400000);
    return `${ymd}/${nd.getFullYear()}${pad2(nd.getMonth() + 1)}${pad2(nd.getDate())}`;
  }
  // Emit 6-digit HHMMSS — a single-digit hour like "6:30" must become
  // "063000", not "63000", or Google drops the prefilled time — and keep the
  // range moving forward when an event crosses midnight (a "23:30" block ends
  // on the next calendar day, not earlier the same day).
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmt = (min) => pad2(Math.floor(min / 60) % 24) + pad2(min % 60) + '00';
  const startMin = toMin(times[0]);
  let endMin = times[1] ? toMin(times[1]) : startMin + 60;   // default 1-hour block
  if (endMin <= startMin) endMin += 1440;                    // wraps past midnight
  let endYmd = ymd;
  if (endMin >= 1440) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + Math.floor(endMin / 1440));
    endYmd = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }
  return `${ymd}T${fmt(startMin)}/${endYmd}T${fmt(endMin)}`;
}
function calendarAddUrl(title, dateStr, timeLabel) {
  const range = gcalDateRange(dateStr, timeLabel);
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title || 'event' });
  if (range) params.set('dates', range);
  params.set('details', 'Added from Shape Rotator OS');
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── OS feedback + idea box ──────────────────────────────────────────────────
// A small anonymous feedback pill pinned to the bottom-center window edge.
// Clicking it lifts the card a few pixels and blooms a textarea open; once more
// than 5 characters are typed the send button enables and posts ONE anonymous
// row to Supabase (message + coarse app context only — see
// ../supabase-feedback.mjs). Self-contained: returns a dispose() the membrane
// controller calls on teardown to clear timers + the outside-click listener
// (the DOM itself is dropped when the host innerHTML is cleared).
function setupFeedbackBox(container) {
  const root = container.querySelector('[data-feedback]');
  if (!root) return { dispose() {} };
  const toggle = root.querySelector('[data-feedback-toggle]');
  const input = root.querySelector('[data-feedback-input]');
  const sendBtn = root.querySelector('[data-feedback-send]');
  const statusEl = root.querySelector('[data-feedback-status]');

  // Coarse, non-identifying app context, resolved once and best-effort: a
  // failure just leaves both columns null (both are nullable in the table).
  let appCtx = { appVersion: null, platform: null };
  try {
    Promise.resolve(window.api?.getAppInfo?.()).then((info) => {
      if (info && typeof info === 'object') {
        appCtx = { appVersion: info.version || null, platform: info.platform || null };
      }
    }).catch(() => {});
  } catch {}

  let cooldownTimer = null;
  let collapseTimer = null;
  let sending = false;

  function setOpen(open) {
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) setTimeout(() => { try { input.focus(); } catch {} }, 80);
  }

  function refreshSend() {
    const valid = input.value.trim().length >= FEEDBACK_MIN_LENGTH;
    sendBtn.disabled = sending || cooldownTimer != null || !valid;
  }

  function setStatus(text, tone) {
    statusEl.textContent = text || '';
    if (tone) statusEl.dataset.tone = tone; else delete statusEl.dataset.tone;
  }

  toggle.addEventListener('click', () => {
    const open = !root.classList.contains('is-open');
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    setOpen(open);
    if (open) { setStatus('', null); refreshSend(); }
  });

  input.addEventListener('input', () => {
    if (statusEl.textContent) setStatus('', null);
    refreshSend();
  });

  async function send() {
    if (sendBtn.disabled || sending) return;
    sending = true;
    refreshSend();
    setStatus('sending…', 'pending');
    const res = await submitFeedback({
      message: input.value,
      appVersion: appCtx.appVersion,
      platform: appCtx.platform,
    });
    sending = false;
    if (res && res.ok) {
      input.value = '';
      setStatus('thanks — sent.', 'ok');
      // Brief client-side cooldown so the public insert endpoint can't be held
      // down; the server-side length CHECK + RLS are the real guard.
      cooldownTimer = setTimeout(() => { cooldownTimer = null; refreshSend(); }, 5000);
      refreshSend();
      collapseTimer = setTimeout(() => { setOpen(false); collapseTimer = null; }, 1500);
    } else {
      setStatus(
        res && res.error === 'unconfigured'
          ? 'feedback isn’t set up here.'
          : 'couldn’t send — try again.',
        'err',
      );
      refreshSend();
    }
  }

  sendBtn.addEventListener('click', send);

  // Collapse on a click anywhere outside the box (only while open). Bound to the
  // membrane host, not document, so it cannot outlive this mount; also removed
  // in dispose() for good measure.
  function onOutside(ev) {
    if (!root.classList.contains('is-open')) return;
    if (root.contains(ev.target)) return;
    setOpen(false);
  }
  container.addEventListener('mousedown', onOutside);

  return {
    dispose() {
      if (cooldownTimer) clearTimeout(cooldownTimer);
      if (collapseTimer) clearTimeout(collapseTimer);
      container.removeEventListener('mousedown', onOutside);
    },
  };
}

export function mountMembrane(container, opts = {}) {
  cp('membrane:mount-start');
  container.classList.add('membrane-host');
  // Hub prototype flag — scopes the field-feed/capture-bar styles and the
  // die's ambient dimming (membrane.css). One class to rip out if we revert.
  container.classList.add('membrane-hub');
  // Always start showing the shapes, never the Rubik's cube — clear any stale
  // reveal state left on the (reused) container from a previous visit, so the
  // cube overlay and its Scramble/Reset controls don't linger after coming back.
  container.classList.remove('membrane-rubiks-active');
  // First-arrival choreography — the rails/feedback/glow unfold once per app
  // session (see .is-arriving in membrane.css). Session-scoped so revisiting
  // the membrane mid-session stays instant (arrival is a first-load moment,
  // not a page-switch tax); skipped entirely under reduced motion. The stray
  // class removal after teardown is a harmless no-op.
  try {
    if (!prefersReducedMotion() && !sessionStorage.getItem('srwk:membrane:arrived')) {
      sessionStorage.setItem('srwk:membrane:arrived', '1');
      container.classList.add('is-arriving');
      setTimeout(() => { try { container.classList.remove('is-arriving'); } catch {} }, 1400);
    }
  } catch {}

  container.innerHTML = `
    <div class="membrane-stage">
      <div class="membrane-atmosphere" aria-hidden="true">
        <div class="ma-throne-presence"></div>
      </div>
      <!-- Not aria-hidden: these rails hold operable, labelled controls (open
           the calendar / a profile, dismiss). Hiding them from the a11y tree
           while leaving focusable buttons inside is a broken contract — they
           are named regions instead so keyboard/SR users reach them. -->
      <!-- Right column pairs the compact calendar with the ask/update stack
           beneath it (2026-07-04: "pair the bottom-left updates to the top
           right") — one cluster, one edge. -->
      <div class="membrane-right-col" aria-hidden="false">
        <div class="membrane-agenda" data-agenda role="region" aria-label="today's agenda"></div>
        <div class="membrane-field-feed" data-mfield role="region" aria-label="the cohort today"></div>
      </div>
      <div class="membrane-feed" data-feed role="region" aria-label="what's new"></div>
      <canvas class="membrane-canvas"></canvas>
      <canvas class="membrane-rubiks-canvas" aria-hidden="true"></canvas>
      <!-- Bright light flash that blankets the die<->Rubik's swap. Fired ONLY by
           revealRubiks()/hideRubiks() — the normal shape morphs never touch it. -->
      <div class="membrane-flash" aria-hidden="true"></div>
      <div class="membrane-rubiks-controls" aria-hidden="true">
        <button type="button" class="primary" data-rubiks-scramble aria-label="Scramble">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/>
            <path d="m18 2 4 4-4 4"/>
            <path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/>
            <path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/>
            <path d="m18 14 4 4-4 4"/>
          </svg>
        </button>
        <button type="button" data-rubiks-reset aria-label="Reset">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
        </button>
      </div>
      <div class="membrane-shape-name" aria-hidden="true">
        <span class="msn-name" data-shape-name></span>
        <span class="msn-meta" data-shape-meta></span>
      </div>
      <!-- the say/did/maybe capture bar (the field-feed itself now lives in
           .membrane-right-col, paired under the agenda — see above). Type
           first, verb after; Tab cycles the verb; Enter posts. v0 writes
           locally (see FIELD_VERBS). -->
      <form class="membrane-capture" data-mcap autocomplete="off">
        <div class="mcap-verbs" role="group" aria-label="what kind of post">
          ${FIELD_VERB_ORDER.map((v, i) => `
            <button type="button" class="mcap-verb${i === 0 ? ' is-active' : ''}" data-mcap-verb="${v}" aria-pressed="${i === 0 ? 'true' : 'false'}">${FIELD_VERBS[v].label}</button>
          `).join('')}
        </div>
        <input class="mcap-input" data-mcap-input type="text" maxlength="280"
               placeholder="${FIELD_VERBS.say.hint} · tab switches verb"
               aria-label="post to the cohort" />
        <button type="submit" class="mcap-send" data-mcap-send disabled>post</button>
      </form>
      <div class="membrane-feedback" data-feedback>
        <div class="membrane-feedback-card">
          <button type="button" class="membrane-feedback-pill" data-feedback-toggle
                  aria-expanded="false" aria-controls="membrane-feedback-panel">
            <span class="mfb-spark" aria-hidden="true">✦</span>
            <span class="mfb-label">OS feedback and idea-box</span>
          </button>
          <div class="membrane-feedback-body" id="membrane-feedback-panel" data-feedback-panel>
            <textarea class="membrane-feedback-input" data-feedback-input rows="3"
                      maxlength="${FEEDBACK_MAX_LENGTH}"
                      placeholder="Share feedback or an idea — anonymous."
                      aria-label="OS feedback and idea-box"></textarea>
            <div class="membrane-feedback-actions">
              <span class="membrane-feedback-status" data-feedback-status role="status" aria-live="polite"></span>
              <button type="button" class="membrane-feedback-send" data-feedback-send disabled>send</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const canvas = container.querySelector('.membrane-canvas');
  const shapeNameEl = container.querySelector('[data-shape-name]');
  const shapeMetaEl = container.querySelector('[data-shape-meta]');

  // Right-side label naming the current shape (so it can be referenced).
  function updateShapeName(faces) {
    const info = SHAPE_NAMES[faces];
    if (!info || !shapeNameEl) return;
    shapeNameEl.textContent = info.name;
    shapeMetaEl.textContent = `${info.tag ? info.tag + ' · ' : ''}${faces} faces`;
  }

  // Ambient TODAY-only agenda pinned to the right edge, sitting behind the
  // cube. Timed events are placed on a vertical time axis with hour ticks,
  // and a glowing line marks the current time. Re-rendered on data load and
  // once a minute (so the now-line and time window track the clock).
  const agendaEl = container.querySelector('[data-agenda]');
  const agendaDismissed = makeDismissStore('srwk:membrane:dismissed:agenda');
  // eventsToday is derived UPSTREAM (alchemy.js) at data-push time with that
  // moment's clock and only refreshes on the next setData — but the 60s tick
  // keeps re-rendering with the CURRENT clock. Past midnight that combination
  // re-keys yesterday's events under the new day: the agenda showed them under
  // the fresh "today" header, and calendar-watch burst them out as spurious
  // "event-new" / false "event-soon" cards. Until fresh data arrives, a stale
  // day means NO today-events (the date-carrying upcoming list stays usable).
  let eventsDataDay = null;   // local YMD stamped when events data arrives
  const localDayStamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const eventsTodayFresh = () => (
    eventsDataDay === localDayStamp() && Array.isArray(dataStore.events?.eventsToday)
      ? dataStore.events.eventsToday : []
  );
  // Keys rendered last pass, so a re-render slides in only genuinely-new cards
  // (null until the first render — see markEnteringRows).
  let agendaPrevKeys = null;
  function renderAgenda() {
    if (!agendaEl) return;
    // Don't rebuild while a card is mid-recede — the once-a-minute timer or a
    // data load would otherwise snap the fold animation. The dismiss's own
    // completion calls renderAgenda() after the element is gone, so nothing is
    // lost by skipping here.
    if (agendaEl.querySelector('.is-dismissing')) return;
    const events = eventsTodayFresh();
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();

    const timed = [];
    const allDay = [];
    for (const e of events) {
      const start = parseDayMinutes(e.time);
      if (start == null) allDay.push(e);
      else timed.push({ e, start });
    }
    timed.sort((a, b) => a.start - b.start);

    // Time window: span the events + now, padded, with a sane minimum.
    const anchors = timed.map((t) => t.start).concat([nowMin]);
    let lo = Math.min(...anchors) - 60;
    let hi = Math.max(...anchors) + 90;
    if (hi - lo < 360) { const mid = (lo + hi) / 2; lo = mid - 180; hi = mid + 180; }
    lo = Math.max(0, Math.round(lo));
    hi = Math.min(1440, Math.round(hi));
    const span = Math.max(60, hi - lo);
    const topPct = (m) => Math.max(0, Math.min(100, ((m - lo) / span) * 100));

    let ticks = '';
    const nowPct = topPct(nowMin);
    for (let h = Math.ceil(lo / 60); h <= Math.floor(hi / 60); h++) {
      const tickPct = topPct(h * 60);
      // Both labels pin to the right edge, so an hour label too close to now
      // sits under the (brighter) now-label — keep the rule, drop just the
      // text. Proximity is measured in track PERCENT, not minutes: a sparse
      // day compresses many minutes into a label-height, a dense window few
      // (~3.4% ≈ one 14px label on a typical ~400px track).
      const label = Math.abs(tickPct - nowPct) < 3.4 ? '' : `<span class="magenda-tick-label">${pad2(h)}:00</span>`;
      ticks += `<div class="magenda-tick" style="top:${tickPct.toFixed(2)}%">${label}</div>`;
    }
    // title recovers ellipsis-truncated names AND names the click destination.
    const rows = timed.map(({ e, start }) =>
      `<button type="button" class="magenda-event" data-cat="${agendaCat(e.title)}" style="top:${topPct(start).toFixed(2)}%" title="${escHtml(`${e.title || 'untitled'} — open calendar`)}">
        <span class="magenda-event-time">${escHtml(e.time)}</span>
        <span class="magenda-event-title">${escHtml(e.title || 'untitled')}</span>
      </button>`).join('');
    const nowLine = `<div class="magenda-now" style="top:${topPct(nowMin).toFixed(2)}%"><span class="magenda-now-label">${pad2(now.getHours())}:${pad2(now.getMinutes())}</span></div>`;

    // Upcoming events grouped by day; headers show the weekday name + date
    // (recomputed from each item's date at render time).
    const upcoming = Array.isArray(dataStore.events?.eventsUpcoming) ? dataStore.events.eventsUpcoming : [];
    const dayLabel = (dateStr) => {
      const d = new Date(`${dateStr}T00:00:00`);
      if (Number.isNaN(d.getTime())) return '';
      return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
    };
    const groups = [];
    const gIndex = new Map();
    for (const it of upcoming) {
      if (!gIndex.has(it.date)) { const g = { date: it.date, items: [] }; gIndex.set(it.date, g); groups.push(g); }
      gIndex.get(it.date).items.push(it);
    }

    // Unified card — same chrome as the left feed item, with a calendar-
    // category color tint (data-cat) and an accent edge-bar. Title (primary)
    // over an optional sub line (time / "all day"). The card opens the
    // calendar; the quiet dismiss control (revealed on hover/focus) closes the
    // notification. `dateStr` keys the dismissal to this one occurrence.
    const todayStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    // Disambiguate same-day, same-title, same-sub cards with an occurrence
    // ordinal so dismissing one never silently eats its visual twin. First
    // occurrence keeps the bare key (back-compatible with earlier dismissals).
    const keyN = new Map();
    const card = (title, sub, dateStr) => {
      const base = `${dateStr || ''}|${title || ''}|${sub || ''}`;
      const n = keyN.get(base) || 0; keyN.set(base, n + 1);
      const key = n ? `${base}#${n}` : base;
      if (agendaDismissed.has(key)) return '';
      const ek = escHtml(key);
      const calUrl = escHtml(calendarAddUrl(title, dateStr, sub));
      return `<div class="magenda-up" data-cat="${agendaCat(title)}" data-row-key="${ek}">
        <button type="button" class="magenda-add" data-cal-url="${calUrl}" aria-label="add ${escHtml(title || 'event')} to calendar" title="add to calendar">${CAL_PLUS}</button>
        <button type="button" class="magenda-up-event" data-up-key="${ek}">
          <span class="magenda-event-title">${escHtml(title || 'untitled')}</span>${sub ? `<span class="magenda-event-time">${escHtml(sub)}</span>` : ''}
        </button>
        <button type="button" class="magenda-dismiss" data-dismiss-key="${ek}" aria-label="dismiss ${escHtml(title || 'event')}" title="dismiss">${DISMISS_X}</button>
      </div>`;
    };

    const todayEmpty = timed.length === 0;
    let html = '';
    // "Next up" leads the rail — the single most imminent thing with a live
    // countdown (today's next timed event, else the first look-ahead item), so
    // the right side answers "what's next?" before it shows the snapshot
    // (2026-07-02 feedback: focus on what's next, not just a snapshot).
    const nextTimed = timed.find((t) => t.start >= nowMin);
    let nextUp = null;
    if (nextTimed) {
      const mins = nextTimed.start - nowMin;
      const when = mins < 1 ? 'now' : mins < 60 ? `in ${mins} min` : `in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
      nextUp = { title: nextTimed.e.title, sub: `today ${nextTimed.e.time} · ${when}` };
    } else if (groups.length && groups[0].items.length) {
      const it = groups[0].items[0];
      nextUp = { title: it.title, sub: `${dayLabel(groups[0].date)}${it.time ? ' · ' + it.time : ''}` };
      // The hero IS this look-ahead item — pull it from its group so the rail
      // never shows the same event twice (hero + identical day-card/later row).
      // Today's-next-timed hero above keeps its axis row: the timeline is a
      // different presentation, not a repeat.
      groups[0].items = groups[0].items.slice(1);
    }
    if (nextUp) {
      html += `<button type="button" class="magenda-next" data-cat="${agendaCat(nextUp.title)}" title="${escHtml(`${nextUp.title || 'untitled'} — open calendar`)}">
        <span class="magenda-next-eyebrow">next up</span>
        <span class="magenda-event-title">${escHtml(nextUp.title || 'untitled')}</span>
        <span class="magenda-event-time">${escHtml(nextUp.sub)}</span>
      </button>`;
    }
    // Today header — same chrome as the day headers below, with a "today"
    // prefix (from main). Keep the per-occurrence dateStr key on the card call
    // so same-day duplicate titles stay individually dismissable.
    html += `<div class="magenda-day-head">${escHtml(`today · ${WD[now.getDay()]} ${MO[now.getMonth()]} ${now.getDate()}`)}</div>`;
    // Today's all-day items as cards.
    for (const e of allDay) html += card(e.title, e.ongoing ? 'all day' : '', todayStr);
    // Today's timed events keep the time axis + now-line (only when present).
    if (!todayEmpty) html += `<div class="magenda-track">${ticks}${rows}${nowLine}</div>`;
    // Quiet note when today has nothing but there's a look-ahead.
    if (todayEmpty && !allDay.length && groups.length) html += `<div class="magenda-quiet">nothing today</div>`;
    // Upcoming, grouped by day — but only the next 7 days rate full cards.
    // Anything further folds into one quiet "later" block: a lone far-off
    // event under its own day head ("final demo day" under WED JUL 22) read
    // as stuck to the rail bottom (2026-07-03 feedback).
    const aheadDays = (ds) => Math.round(
      (new Date(`${ds}T00:00:00`).getTime() - new Date(`${todayStr}T00:00:00`).getTime()) / 86400000);
    // Drop day groups the hero dedup emptied — a day head with no cards
    // under it reads as a rendering bug.
    const nearGroups = groups.filter((g) => g.items.length && aheadDays(g.date) <= 7);
    const farItems = groups.filter((g) => aheadDays(g.date) > 7)
      .flatMap((g) => g.items.map((it) => ({ ...it, date: g.date })));
    for (const g of nearGroups) {
      html += `<div class="magenda-day-head">${escHtml(dayLabel(g.date))}</div>`;
      for (const it of g.items) html += card(it.title, it.time, g.date);
    }
    if (farItems.length) {
      html += `<div class="magenda-day-head">later</div>`;
      for (const it of farItems.slice(0, 3)) {
        html += `<button type="button" class="magenda-later" data-cat="${agendaCat(it.title)}" title="${escHtml(`${it.title || 'untitled'} — open calendar`)}">
          <span class="magenda-event-title">${escHtml(it.title || 'untitled')}</span>
          <span class="magenda-event-time">${escHtml(dayLabel(it.date))}${it.time ? ' · ' + escHtml(it.time) : ''}</span>
        </button>`;
      }
      if (farItems.length > 3) html += `<div class="magenda-quiet">+${farItems.length - 3} more ahead</div>`;
    }
    // Truly nothing on the horizon.
    if (todayEmpty && !allDay.length && !groups.length) html += `<div class="magenda-quiet">clear ahead</div>`;

    agendaEl.innerHTML = html;
    agendaPrevKeys = markEnteringRows(agendaEl, agendaPrevKeys, '.magenda-up');
  }
  // Once-a-minute tick advances the agenda now-line AND recomputes the incoming
  // band (so "tea — in 12 min" counts down live, not just on a cohort refresh).
  const agendaTimer = setInterval(() => { renderAgenda(); renderFeed(); renderFieldFeed(); }, 60 * 1000);
  // Clicking a dismiss control closes that notification; clicking the card
  // itself opens the calendar in a new OS tab (same as clicking through from
  // the calendar view).
  agendaEl?.addEventListener('click', (ev) => {
    // Add-to-calendar — opens a prefilled Google Calendar event in the system
    // browser (the proven https-only openExternal path). Stops here so the
    // card's own click (open the full calendar) doesn't also fire.
    const add = ev.target.closest('.magenda-add');
    if (add) {
      ev.preventDefault();
      ev.stopPropagation();
      const url = add.dataset.calUrl;
      if (url && window.api && typeof window.api.openExternal === 'function') {
        window.api.openExternal(url);
      }
      return;
    }
    const x = ev.target.closest('.magenda-dismiss');
    if (x) {
      ev.preventDefault();
      ev.stopPropagation();
      agendaDismissed.add(x.dataset.dismissKey);
      dismissCard(x.closest('.magenda-up'), () => renderAgenda());
      return;
    }
    if (!ev.target.closest('.magenda-up-event, .magenda-event, .magenda-next, .magenda-later')) return;
    if (typeof window.__srwkOpenInNewTab === 'function') {
      window.__srwkOpenInNewTab({ tab: 'alchemy', mode: 'calendar' });
    }
  });

  // "What's new" feed pinned to the LEFT edge, behind the cube — a mirror of
  // the agenda. Color-coded by kind (release / transcript / ask), minimal:
  // a colored dot, a short label, a relative age. Newest first.
  const feedEl = container.querySelector('[data-feed]');
  const feedDismissed = makeDismissStore('srwk:membrane:dismissed:feed');
  let feedPrevKeys = null;
  // ── category popover state ──
  // One panel anchored beside the rail carries ALL category detail: hover
  // previews it (and the pointer can travel into it), click pins it. Closing
  // never dismisses — the panel's own "clear" does that explicitly
  // (2026-07-03: the X-to-close was nuking the notifications).
  let feedPopCat = null;      // category id the popover is showing
  let feedPopPinned = false;  // pinned by click — stays until closed
  let feedPopHideTimer = null;
  let feedPopCats = [];       // categories from the last renderFeed pass
  let feedPopEl = null;
  // The transcript review box is user-resizable; its size persists (localStorage,
  // like a window size) so the next transcript / a re-open keeps the shape you
  // set. Bounds mirror the min/max in .mfeed-pop[data-kind="transcript"].
  const TRANSCRIPT_POP_SIZE_KEY = 'srwk:membrane:transcript_pop_size_v1';
  const loadTranscriptPopSize = () => {
    try {
      const s = JSON.parse(localStorage.getItem(TRANSCRIPT_POP_SIZE_KEY) || 'null');
      if (s && s.w >= 320 && s.w <= 640 && s.h >= 220) return s;
    } catch {}
    return null;
  };
  const saveTranscriptPopSize = (w, h) => {
    if (!(w > 100 && h > 100)) return; // never persist the 0×0 of a closed panel
    try { localStorage.setItem(TRANSCRIPT_POP_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch {}
  };
  // Rail-level leave guard, attached ONCE to the persistent [data-feed] node.
  // The per-row mouseenter/mouseleave pairs die whenever renderFeed rebuilds
  // the rows (innerHTML) under the pointer — a preview whose closing
  // mouseleave was eaten that way used to stay open forever. The rail node
  // itself survives every rebuild, so this net always fires on the way out.
  feedEl?.addEventListener('mouseenter', () => clearTimeout(feedPopHideTimer));
  feedEl?.addEventListener('mouseleave', () => { if (feedPopCat && !feedPopPinned) scheduleFeedPopHide(); });
  // Hidden TYPES (filter chips at the rail top) — persisted, and separate
  // from dismissals: hiding a type is reversible, clearing is not.
  const FEED_FILTER_KEY = 'srwk:membrane:feed_filter_v0';
  const feedHidden = (() => {
    try {
      const a = JSON.parse(localStorage.getItem(FEED_FILTER_KEY) || '[]');
      return new Set(Array.isArray(a) ? a : []);
    } catch { return new Set(); }
  })();
  const saveFeedHidden = () => {
    try { localStorage.setItem(FEED_FILTER_KEY, JSON.stringify([...feedHidden])); } catch {}
  };
  // Incoming-watch cards are also remembered locally so a 60s re-render between
  // cohort refreshes can't resurrect a just-dismissed card; dismissing one ALSO
  // acknowledges it in the watch ledger (acknowledgeIncoming) so a fresh compute
  // won't resurface it across launches.
  const incomingDismissed = makeDismissStore('srwk:membrane:dismissed:incoming', 'local');
  function feedAge(date) {
    const then = Date.parse(date);
    if (!Number.isFinite(then)) return '';
    // Calendar-day difference (not 24h buckets): an item later TODAY reads
    // "today", not "in 1d"; future items read forward ("today" for a July 22
    // event was the original bug).
    const day = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(Date.now()) - day(then)) / 86400000);
    if (days < 0) {
      const ahead = -days;
      if (ahead < 7) return `in ${ahead}d`;
      return `in ${Math.floor(ahead / 7)}w`;
    }
    if (days === 0) return 'today';
    if (days === 1) return '1d';
    if (days < 7) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
  }
  const feedKey = (it) => `${it.kind || ''}|${it.date || ''}|${it.label || ''}|${it.meta || ''}`;
  function openContextTranscripts() {
    if (typeof window.__srwkOpenInNewTab === 'function') {
      window.__srwkOpenInNewTab({ tab: 'alchemy', mode: 'context', contextView: 'stream' });
    }
  }
  // Forward-looking "incoming" band atop the same left rail as "what's new".
  // Derives tea-time / arrival / new-event / time-change cards from the agenda
  // the membrane already holds (see calendar-watch.js) — recomputed on every
  // render + the 60s tick so "in N min" stays live.
  function incomingCards() {
    const ev = dataStore.events || {};
    return computeIncoming({
      eventsToday: eventsTodayFresh(),   // stale-day guard — see its comment
      eventsUpcoming: ev.eventsUpcoming,
      people: dataStore.people,
      nowMs: Date.now(),
    }).cards.filter((c) => !incomingDismissed.has(c.seenKey));
  }
  function categoryCountLabel(cat) {
    const n = cat.members.length;
    const unit = n === 1 ? cat.unit : (cat.plural || `${cat.unit}s`);
    return `${n} ${unit}`;
  }
  function categoryItemAge(member) {
    if (member.type === 'incoming') return member.card?.detail || '';
    return feedAge(member.it?.date);
  }
  function categoryItemMeta(member) {
    if (member.type === 'incoming') return member.card?.detail || '';
    return member.it?.meta || '';
  }
  function categoryItemLabel(member) {
    if (member.type === 'incoming') return member.card?.title || '';
    return member.it?.label || '';
  }
  // ── the category popover ──────────────────────────────────────────────
  // Hover a category → this panel appears beside the rail with the actual
  // content (labels, meta, transcript excerpts). The pointer can travel into
  // it (grace timer below) and its list scrolls — unlike the old fly-out,
  // which was pointer-events:none and clipped by the rail mask. Click pins.
  function ensureFeedPop() {
    if (feedPopEl) return feedPopEl;
    feedPopEl = document.createElement('div');
    feedPopEl.className = 'mfeed-pop';
    feedPopEl.setAttribute('role', 'region');
    feedPopEl.hidden = true;
    (container.querySelector('.membrane-stage') || container).appendChild(feedPopEl);
    feedPopEl.addEventListener('mouseenter', () => clearTimeout(feedPopHideTimer));
    feedPopEl.addEventListener('mouseleave', () => { if (!feedPopPinned) scheduleFeedPopHide(); });
    // Persist a manual resize: the native corner-drag ends in a mouseup over the
    // panel, so read the box size then and remember it (transcripts only, and
    // never the collapsed 0×0 of a just-closed panel).
    feedPopEl.addEventListener('mouseup', () => {
      if (feedPopEl.dataset.kind !== 'transcript' || feedPopEl.hidden) return;
      const r = feedPopEl.getBoundingClientRect();
      saveTranscriptPopSize(r.width, r.height);
    });
    return feedPopEl;
  }
  function scheduleFeedPopHide() {
    clearTimeout(feedPopHideTimer);
    feedPopHideTimer = setTimeout(() => { if (!feedPopPinned) closeFeedPop(); }, 240);
  }
  function closeFeedPop() {
    clearTimeout(feedPopHideTimer);
    feedPopCat = null;
    feedPopPinned = false;
    if (feedPopEl) feedPopEl.hidden = true;
    if (!feedEl) return;
    feedEl.querySelectorAll('.mfeed-category-row.is-popped').forEach((r) => r.classList.remove('is-popped'));
    feedEl.querySelectorAll('[data-feed-category-toggle]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
  function openFeedPop(id, pin) {
    clearTimeout(feedPopHideTimer);
    feedPopCat = id;
    if (pin != null) feedPopPinned = pin;
    renderFeedPop();
  }
  function renderFeedPop() {
    const cat = feedPopCats.find((c) => c.id === feedPopCat);
    if (!cat) { closeFeedPop(); return; }
    const pop = ensureFeedPop();
    pop.classList.toggle('is-pinned', feedPopPinned);
    // Tag the panel with its kind so transcripts can render a wider, more
    // readable review box (readouts carry excerpts worth actually reading);
    // every other kind stays compact. See .mfeed-pop[data-kind="transcript"].
    pop.dataset.kind = cat.kind || '';
    // Transcripts get the resizable review box — restore the size the user last
    // dragged it to (persists across transcripts). Every other kind clears the
    // inline size back to its compact CSS default (the panel is a shared node).
    if (cat.kind === 'transcript') {
      const sz = loadTranscriptPopSize();
      if (sz) { pop.style.width = `${sz.w}px`; pop.style.height = `${sz.h}px`; }
      else { pop.style.removeProperty('width'); pop.style.removeProperty('height'); }
    } else {
      pop.style.removeProperty('width');
      pop.style.removeProperty('height');
    }
    pop.setAttribute('aria-label', `${cat.title} — ${categoryCountLabel(cat)}`);
    const rows = cat.members.slice(0, 30).map((m, i) => {
      const label = categoryItemLabel(m);
      const meta = categoryItemMeta(m);
      const age = categoryItemAge(m);
      // Transcripts carry their first lines — the difference between
      // "walking-notes" meaning nothing and meaning something.
      const excerpt = (m.type === 'feed' && m.it?.excerpt) ? m.it.excerpt : '';
      return `
        <button type="button" class="mfeed-detail-row mfeed-pop-row mfeed-${escHtml(m.kind || cat.kind)}" data-pop-item="${i}"
                aria-label="${escHtml([label, meta, age, m.recordId ? 'open profile' : feedCta(m.kind || cat.kind)].filter(Boolean).join('. '))}">
          ${feedIcon(m.icon || m.kind || cat.kind)}
          <span class="mfeed-body">
            <span class="mfeed-label">${escHtml(label)}</span>
            <span class="mfeed-meta">${escHtml(meta)}</span>
            ${excerpt ? `<span class="mfeed-pop-excerpt">${escHtml(excerpt)}</span>` : ''}
          </span>
          <span class="mfeed-age">${escHtml(age)}</span>
        </button>`;
    }).join('');
    pop.innerHTML = `
      <div class="mfeed-pop-head mfeed-${escHtml(cat.kind)}">
        ${feedIcon(cat.kind)}
        <span class="mfeed-pop-title">${escHtml(cat.title)}</span>
        <span class="mfeed-pop-count">${escHtml(categoryCountLabel(cat))}</span>
        <span class="mfeed-pop-actions">
          <button type="button" class="mfeed-pop-act" data-pop-open>${escHtml(cat.cta || 'open')}</button>
          <button type="button" class="mfeed-pop-act mfeed-pop-clear" data-pop-clear
                  title="dismiss all ${escHtml(cat.title)} notifications">clear</button>
          <button type="button" class="mfeed-pop-x" data-pop-close aria-label="close (keeps notifications)" title="close">${DISMISS_X}</button>
        </span>
      </div>
      <div class="mfeed-pop-list" role="list">${rows}</div>`;
    // Close = collapse, nothing else. Clear = the explicit dismissal.
    // Optional-chained: if any control were ever missing from the template, a
    // TypeError here would strand the panel open with NO close handlers at all.
    pop.querySelector('[data-pop-close]')?.addEventListener('click', () => closeFeedPop());
    pop.querySelector('[data-pop-open]')?.addEventListener('click', () => { openFeedCategory(cat); closeFeedPop(); });
    pop.querySelector('[data-pop-clear]')?.addEventListener('click', () => {
      for (const member of cat.members) {
        if (member.type === 'incoming') {
          incomingDismissed.add(member.dismissKey);
          acknowledgeIncoming(member.dismissKey);
        } else {
          feedDismissed.add(member.dismissKey);
        }
      }
      closeFeedPop();
      renderFeed();
    });
    pop.querySelectorAll('[data-pop-item]').forEach((btn) => {
      btn.addEventListener('click', () => openFeedCategoryItem(cat.members[+btn.dataset.popItem]));
    });
    // Anchor beside the hovered row, clamped so the panel never runs off the
    // stage bottom (its list scrolls internally past max-height).
    pop.hidden = false;
    const row = feedEl?.querySelector(`[data-feed-category="${cat.id}"]`);
    const stage = container.querySelector('.membrane-stage');
    if (row && stage) {
      const r = row.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const top = Math.max(12, Math.min(r.top - s.top, s.height - pop.offsetHeight - 14));
      pop.style.top = `${Math.round(top)}px`;
    }
    feedEl?.querySelectorAll('.mfeed-category-row').forEach((r2) =>
      r2.classList.toggle('is-popped', r2.dataset.feedCategory === cat.id));
    feedEl?.querySelectorAll('[data-feed-category-toggle]').forEach((b) =>
      b.setAttribute('aria-expanded', b.dataset.feedCategoryToggle === cat.id ? 'true' : 'false'));
  }
  // Collapsed row only — ALL detail lives in the popover (hover to peek,
  // click to pin). No in-flow expansion: inside this masked, fixed-width rail
  // it clipped mid-list and couldn't scroll (2026-07-03 feedback).
  function feedCategoryHtml(cat) {
    const top = cat.members[0];
    return `
      <div class="mfeed-category-row" data-row-key="${escHtml(cat.rowKey)}" data-feed-category="${escHtml(cat.id)}">
        <button type="button" class="mfeed-category mfeed-${escHtml(cat.kind)}" data-feed-category-toggle="${escHtml(cat.id)}"
                aria-expanded="false" aria-haspopup="true"
                aria-label="${escHtml([cat.title, categoryCountLabel(cat), 'open details'].join('. '))}">
          ${feedIcon(cat.kind)}
          <span class="mfeed-body">
            <span class="mfeed-label">${escHtml(cat.title)}</span>
            <span class="mfeed-meta">${escHtml(categoryItemMeta(top) || cat.meta || '')}</span>
          </span>
          <span class="mfeed-inline-count">${escHtml(String(cat.members.length))}</span>
          <span class="mfeed-age">${escHtml(categoryItemAge(top))}</span>
        </button>
        <button type="button" class="mfeed-dismiss" data-category-dismiss="${escHtml(cat.id)}" aria-label="dismiss ${escHtml(cat.title)}" title="dismiss">${DISMISS_X}</button>
      </div>`;
  }
  function openFeedCategoryItem(member) {
    if (!member) return;
    if (member.type === 'incoming') {
      const c = member.card;
      if (c?.recordId && typeof window.__srwkAlchemyShowRecord === 'function') {
        window.__srwkAlchemyShowRecord(c.recordId, 'shapes');
      } else if (c?.nav && typeof window.__srwkOpenInNewTab === 'function') {
        window.__srwkOpenInNewTab({ tab: 'alchemy', ...c.nav });
      }
      return;
    }
    if (member.it?.nav && typeof window.__srwkOpenInNewTab === 'function') {
      window.__srwkOpenInNewTab({ tab: 'alchemy', ...member.it.nav });
    }
  }
  function openFeedCategory(cat) {
    if (!cat) return;
    if (cat.defaultNav && typeof window.__srwkOpenInNewTab === 'function') {
      window.__srwkOpenInNewTab({ tab: 'alchemy', ...cat.defaultNav });
      return;
    }
    openFeedCategoryItem(cat.members[0]);
  }
  function buildFeedCategories(incoming, keyedFeed) {
    const incomingMembers = incoming.map((card) => ({
      type: 'incoming',
      key: `inc:${card.seenKey}`,
      dismissKey: card.seenKey,
      card,
      kind: card.kind,
      icon: card.icon || card.kind,
      recordId: card.recordId || null,
    }));
    const feedMembers = keyedFeed.map(({ it, key }) => ({
      type: 'feed',
      key: `feed:${key}`,
      dismissKey: key,
      it,
      kind: it.kind,
      icon: it.kind,
    }));
    const byKind = (k) => feedMembers.filter((m) => m.kind === k);
    const categories = [
      {
        id: 'transcripts',
        title: 'transcripts',
        kind: 'transcript',
        unit: 'readout',
        plural: 'readouts',
        cta: 'open raw',
        defaultNav: { mode: 'context', contextView: 'stream' },
        members: byKind('transcript'),
      },
      {
        id: 'calendar',
        title: 'calendar',
        kind: 'event',
        unit: 'notice',
        plural: 'notices',
        cta: 'open calendar',
        defaultNav: { mode: 'calendar' },
        members: [...incomingMembers, ...byKind('event')],
      },
      {
        id: 'shipping',
        title: 'shipping',
        kind: 'release',
        unit: 'update',
        plural: 'updates',
        cta: 'open activity',
        defaultNav: { mode: 'shapes' },
        // Newest-first across releases + commits + captured did posts, so a
        // just-posted did surfaces as the category's visible top row instead
        // of hiding under the whole release backlog.
        members: [...byKind('release'), ...byKind('commit')].sort((a, b) =>
          (Date.parse(b.it?.date || '') || 0) - (Date.parse(a.it?.date || '') || 0)),
      },
      {
        id: 'asks',
        title: 'asks',
        kind: 'ask',
        unit: 'ask',
        plural: 'asks',
        cta: 'open asks',
        defaultNav: { mode: 'activity' },
        members: byKind('ask'),
      },
    ].filter((cat) => cat.members.length);
    for (const cat of categories) {
      cat.rowKey = `cat:${cat.id}|${cat.members.length}|${cat.members.slice(0, 3).map((m) => m.key).join('/')}`;
    }
    return categories;
  }
  function renderFeed() {
    if (!feedEl) return;
    // Don't rebuild while a card is mid-recede (see renderAgenda).
    if (feedEl.querySelector('.is-dismissing')) return;
    const incoming = incomingCards();
    // Locally-captured "did" self-reports merge into the same left rail as the
    // machine shipping items (kind commit → the shipping category) — the did
    // half of the capture bar. fieldPosts is hoisted let-state from the hub
    // block below; renderFeed only ever runs after mount finishes wiring it.
    const didPosts = (fieldPosts || []).filter((p) => p.verb === 'did').map((p) => ({
      kind: 'commit',
      label: `${p.author} — ${p.text}`,
      meta: 'self-report',
      date: new Date(p.ts).toISOString(),
      nav: { mode: 'mirror' },
    }));
    const keyN = new Map();
    const keyedFeed = [...didPosts, ...(Array.isArray(dataStore.feed) ? dataStore.feed : [])]
      // Attach a collision-proof dismiss key (occurrence ordinal for any
      // identical kind|date|label|meta), then drop the already-dismissed.
      .map((it) => {
        const base = feedKey(it);
        const n = keyN.get(base) || 0; keyN.set(base, n + 1);
        return { it, key: n ? `${base}#${n}` : base };
      })
      .filter(({ key }) => !feedDismissed.has(key));
    const categories = buildFeedCategories(incoming, keyedFeed);
    feedPopCats = categories;
    // Type filter — hiding is reversible (unlike dismissing), so the chips
    // render for EVERY category with members, including hidden ones.
    const visible = categories.filter((cat) => !feedHidden.has(cat.id));
    const filterHtml = categories.length ? `
      <div class="mfeed-filter" role="group" aria-label="notification types">
        ${categories.map((cat) => `
          <button type="button" class="mfeed-filter-chip mfeed-${escHtml(cat.kind)}${feedHidden.has(cat.id) ? ' is-off' : ''}"
                  data-feed-filter="${escHtml(cat.id)}" aria-pressed="${feedHidden.has(cat.id) ? 'false' : 'true'}"
                  title="${feedHidden.has(cat.id) ? 'show' : 'hide'} ${escHtml(cat.title)}">
            <i class="mfeed-filter-dot" aria-hidden="true"></i>${escHtml(cat.title)}<span class="mfeed-filter-n">${cat.members.length}</span>
          </button>`).join('')}
      </div>` : '';
    // Leave feedPrevKeys untouched here: if data hasn't loaded yet (first
    // render is empty), prevKeys stays null so the first real population is
    // instant (no stagger-storm) rather than treating every card as "new".
    if (!categories.length) { feedEl.innerHTML = ''; closeFeedPop(); return; }

    // Every type filtered off leaves just the ghost chips — say so, or the
    // rail reads as broken (found via a test tab that had hidden all four).
    feedEl.innerHTML = filterHtml + (visible.length
      ? visible.map(feedCategoryHtml).join('')
      : '<div class="mfeed-allhidden">all types hidden — tap a chip to bring them back</div>');
    feedPrevKeys = markEnteringRows(feedEl, feedPrevKeys, '.mfeed-category-row');
    // Keep the open popover in sync with fresh data (or close it if its
    // category emptied / got hidden). A hover PREVIEW only survives the
    // rebuild if something is still engaging it — pointer over the rail or
    // the panel, or keyboard focus in the rail. Re-painting an abandoned
    // preview open on every 60s tick made it immortal (the mouseleave meant
    // to close it died with the replaced row).
    if (feedPopCat) {
      const engaged = feedPopPinned
        || feedEl.matches(':hover')
        || (feedPopEl && feedPopEl.matches(':hover'))
        || feedEl.contains(document.activeElement);
      if (!engaged) closeFeedPop();
      else if (visible.some((cat) => cat.id === feedPopCat)) renderFeedPop();
      else closeFeedPop();
    }

    feedEl.querySelectorAll('[data-feed-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.feedFilter;
        if (feedHidden.has(id)) feedHidden.delete(id);
        else { feedHidden.add(id); if (feedPopCat === id) closeFeedPop(); }
        saveFeedHidden();
        renderFeed();
      });
    });
    feedEl.querySelectorAll('[data-feed-category-toggle]').forEach((btn) => {
      const id = btn.dataset.feedCategoryToggle;
      // Click toggles the PIN; hover/focus previews (grace timer lets the
      // pointer travel into the panel).
      btn.addEventListener('click', () => {
        if (feedPopCat === id && feedPopPinned) { closeFeedPop(); return; }
        openFeedPop(id, true);
      });
      btn.addEventListener('mouseenter', () => { if (!feedPopPinned) openFeedPop(id, false); });
      btn.addEventListener('mouseleave', () => { if (!feedPopPinned) scheduleFeedPopHide(); });
      btn.addEventListener('focus', () => { if (!feedPopPinned) openFeedPop(id, false); });
      btn.addEventListener('blur', () => { if (!feedPopPinned) scheduleFeedPopHide(); });
    });
    feedEl.querySelectorAll('.mfeed-dismiss').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const cat = categories.find((c) => c.id === btn.dataset.categoryDismiss);
        if (!cat) return;
        for (const member of cat.members) {
          if (member.type === 'incoming') {
            incomingDismissed.add(member.dismissKey);
            acknowledgeIncoming(member.dismissKey);
          } else {
            feedDismissed.add(member.dismissKey);
          }
        }
        if (feedPopCat === cat.id) closeFeedPop();
        dismissCard(btn.closest('.mfeed-category-row'), () => renderFeed());
      });
    });
  }

  let dataStore = {};
  // (feedPinnedCategory is gone: the in-flow click-pin was replaced by the
  // .mfeed-pop popover — state lives in feedPopCat/feedPopPinned above.)

  // ── hub prototype: field feed + capture bar ─────────────────────────────
  // The center feed blends three sources into one "cohort today" stream:
  // open asks (say / maybe by intent), shipping items from what's-new (did),
  // and locally-captured posts. Oldest→newest top-to-bottom, anchored to the
  // capture bar (your post lands right above the input).
  const fieldEl = container.querySelector('[data-mfield]');
  const capForm = container.querySelector('[data-mcap]');
  const capInput = container.querySelector('[data-mcap-input]');
  const capSend = container.querySelector('[data-mcap-send]');
  const capVerbBtns = [...container.querySelectorAll('[data-mcap-verb]')];
  let fieldPosts = loadFieldPosts();
  let capVerb = 'say';

  function selfName() {
    const p = dataStore.self?.profile || {};
    return p.name || p.display_name || p.handle || 'you';
  }

  // Center = the HUMAN layer only: open asks (say) and tentative plans
  // (maybe), orbiting the die. Machine "did" (releases/commits) stays in the
  // left notifications, and locally-captured did posts merge into that same
  // rail (see the didPosts splice in renderFeed) — 2026-07-03 feedback:
  // "put did on the left merged with the notifications, keep the asks in the
  // centre, focus it around the shape."
  function buildFieldItems() {
    const items = [];
    const asks = Array.isArray(dataStore.asks?.asksList) ? dataStore.asks.asksList : [];
    const people = Array.isArray(dataStore.asks?.peopleList) ? dataStore.asks.peopleList : [];
    for (const a of asks) {
      if (!askIsOpen(a)) continue;
      const ts = Date.parse(a.posted_at || a.created_at || '');
      const author = resolveAskAuthor(a, people);
      items.push({
        verb: askIntent(a) === 'come_join' ? 'maybe' : 'say',
        author: (author && (author.name || author.record_id)) || a.author || 'someone',
        text: askTopic(a) || 'untitled',
        ts: Number.isFinite(ts) ? ts : 0,
        joined: askJoinedBy(a).length,
      });
    }
    for (const p of fieldPosts) { if (p.verb !== 'did') items.push(p); }
    items.sort((x, y) => (x.ts || 0) - (y.ts || 0));
    return items.slice(-6);
  }

  // Paired under the calendar block, right-aligned (membrane.css) — newest
  // sits at the bottom, closest to the capture bar it feeds from. Sleeker
  // one-line rows now (2026-07-04 polish): a colored verb dot instead of a
  // full pill, the whole line truncates with an ellipsis, and the `title`
  // carries the untruncated text for a hover reveal.
  function renderFieldFeed() {
    if (!fieldEl) return;
    const items = buildFieldItems();
    // Eyebrow names the surface + the live dot signals that new posts land
    // here on their own — answers "how does something enter this feed?"
    // without a manual anywhere.
    const head = '<div class="mff-head"><i class="mff-live-dot" aria-hidden="true"></i>asks · live</div>';
    if (!items.length) {
      fieldEl.innerHTML = `${head}<div class="mff-quiet">no open asks</div>`;
      return;
    }
    fieldEl.innerHTML = head + items.map((it) => {
      const v = FIELD_VERBS[it.verb] || FIELD_VERBS.say;
      const joined = it.joined ? ` · ${it.joined} in` : '';
      const full = `${v.label}: ${it.author} — ${it.text}${joined}`;
      // First name only — the 196px column can't afford a full name AND the
      // text on one line; the `title` still carries the whole thing.
      const shortAuthor = String(it.author || '').split(/\s+/)[0] || it.author;
      return `
        <div class="mff-row${it.mine ? ' is-mine' : ''}" style="--mff-tint:${v.tint};--mff-ink:${v.ink}" title="${escHtml(full)}">
          <i class="mff-dot" aria-hidden="true"></i>
          <span class="mff-body"><span class="mff-author">${escHtml(shortAuthor)}</span><span class="mff-text">${escHtml(it.text)}${escHtml(joined)}</span></span>
          <span class="mff-age">${escHtml(fieldAge(it.ts))}</span>
        </div>`;
    }).join('');
  }

  function setCapVerb(verb) {
    if (!FIELD_VERBS[verb]) return;
    capVerb = verb;
    for (const b of capVerbBtns) {
      const on = b.dataset.mcapVerb === verb;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (capInput) capInput.placeholder = `${FIELD_VERBS[verb].hint} · tab switches verb`;
  }

  if (capForm) {
    for (const b of capVerbBtns) {
      b.addEventListener('click', () => { setCapVerb(b.dataset.mcapVerb); capInput?.focus(); });
    }
    capInput?.addEventListener('input', () => {
      capSend.disabled = capInput.value.trim().length < 2;
    });
    // Plain Tab cycles the verb (the bar's promised affordance); Shift+Tab
    // still walks focus out, so keyboard users aren't trapped.
    capInput?.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab' || ev.shiftKey) return;
      ev.preventDefault();
      setCapVerb(FIELD_VERB_ORDER[(FIELD_VERB_ORDER.indexOf(capVerb) + 1) % FIELD_VERB_ORDER.length]);
    });
    capForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      // Mirror the input's maxlength here: the attribute only clamps typing,
      // not values that arrive programmatically (paste interception, drivers).
      const text = (capInput?.value || '').trim().slice(0, 280);
      if (text.length < 2) return;
      fieldPosts.push({ verb: capVerb, author: selfName(), text, ts: Date.now(), mine: true });
      fieldPosts = fieldPosts.slice(-50);
      saveFieldPosts(fieldPosts);
      capInput.value = '';
      capSend.disabled = true;
      if (capVerb === 'did') {
        // did lands in the LEFT rail (merged with the shipping notifications);
        // markEnteringRows slides the changed category in.
        renderFeed();
      } else {
        renderFieldFeed();
        const fresh = fieldEl?.lastElementChild; // bottom of the stack = the fresh post
        if (fresh && !prefersReducedMotion()) fresh.classList.add('is-entering');
      }
    });
  }

  // ─── easter-egg Rubik's cube ───────────────────────────────────────────
  // Lazily built on first reveal (loads a ~1.3 MB model) so the membrane has
  // no extra cost until the die has been cycled through every shape. Lives on
  // its own overlaid canvas; revealing it fades the psy-die out under it.
  const rubiksCanvas = container.querySelector('.membrane-rubiks-canvas');
  const rubiksControls = container.querySelector('.membrane-rubiks-controls');
  const rubiksScrambleBtn = container.querySelector('[data-rubiks-scramble]');
  const rubiksResetBtn = container.querySelector('[data-rubiks-reset]');
  let rubiks = null;

  // Bright light flash that blankets the die<->Rubik's swap so the crossfade is
  // never seen. Restart-on-demand: strip the class, force a reflow, re-add — so
  // each transition (in OR out) replays the flash from frame 0. Used ONLY by
  // revealRubiks/hideRubiks; the normal shape morphs never call it.
  const flashEl = container.querySelector('.membrane-flash');
  function flashTransition() {
    if (!flashEl) return;
    flashEl.classList.remove('is-bursting');
    void flashEl.offsetWidth;   // reflow so the keyframes restart
    flashEl.classList.add('is-bursting');
  }

  // Create the Rubik's app (loads its model + builds the cube) once, lazily on
  // first reveal. We deliberately do NOT pre-create it at mount: spinning up a
  // second WebGL context near boot is unnecessary cost and was implicated in a
  // headless-CI render hang. The flash + late-load re-seed (rubiks.js) cover the
  // load so the cube is already spinning when the white-out clears.
  let rubiksLoading = null;   // in-flight import promise (deduped)
  let membraneDestroyed = false;   // set in destroy(); gates the async continuations
  function ensureRubiks() {
    if (rubiks) return Promise.resolve(rubiks);
    if (!rubiksLoading) {
      rubiksLoading = import('./rubiks.js').then(({ createRubiksApp }) => {
        // The page can be destroyed while the chunk is in flight — building
        // the app then would spin up a zombie WebGL renderer + RAF loop +
        // window listeners against the detached canvas, with nothing left
        // holding a dispose handle. Callers already tolerate a null app.
        if (membraneDestroyed) return null;
        rubiks = createRubiksApp(rubiksCanvas, {
          onCycleAway: hideRubiks,
          onSequencing(on) {
            if (rubiksScrambleBtn) rubiksScrambleBtn.disabled = on;
            if (rubiksResetBtn) rubiksResetBtn.disabled = on;
          },
          // Match the die's exact framing so the cube is the same on-screen size
          // as the d6 shape it replaces.
          matchSize: { fov: MEMBRANE_FOV, distance: MEMBRANE_CAMERA_Z, edge: DIE_CUBE_EDGE },
        });
        return rubiks;
      });
      // A transient chunk-load failure must not brick the easter egg for the
      // rest of the mount: clear the cached rejected promise so the next
      // reveal retries the import. (Callers attach their own .catch.)
      rubiksLoading.catch(() => { rubiksLoading = null; });
    }
    return rubiksLoading;
  }

  function revealRubiks() {
    // Fire the flash + label immediately so the white-out covers the lazy
    // import + model load; arm the reveal spin once the app is ready.
    flashTransition();   // white-out the reveal crossfade
    container.classList.add('membrane-rubiks-active');
    if (shapeNameEl) updateRubiksLabel();
    ensureRubiks()
      .then((app) => { if (app) app.setEnabled(true); })
      .catch((e) => console.warn('[membrane] rubiks load failed:', e));
  }

  function hideRubiks() {
    flashTransition();   // white-out the exit crossfade back to the shapes
    container.classList.remove('membrane-rubiks-active');
    if (rubiks) rubiks.setEnabled(false);
    scene.resumeFromRubiks();   // die morphs on into the next regular shape
  }

  // The shape label reads "flashbots cube" while the easter egg is up.
  function updateRubiksLabel() {
    if (!shapeNameEl) return;
    shapeNameEl.textContent = 'flashbots cube';
    shapeMetaEl.textContent = '3×3×3 · drag to turn';
  }

  cp('membrane:before-createScene');
  // The die is decoration; the rails + capture bar are the hub. If WebGL
  // context creation throws (GPU blacklist, --disable-gpu, driver reset),
  // fall back to a no-op scene rather than letting the throw escape
  // mountMembrane — an escaped throw here leaked the already-started 60s
  // agenda interval on EVERY visit (the caller never got the destroy handle)
  // and left the whole landing blank.
  let scene;
  try {
    scene = createMembraneScene(canvas, {
      // Start on the shape we were last showing (remembered across page switches).
      initialFaces: savedFaces,
      // No onEmptyClick: clicking the void no longer summons the panel. The
      // membrane is a pure ambient view now; identity moved to profile ›
      // "your seal". (The die still stops on click / morphs on fast spin —
      // see scene.js.)
      // The die changed shape (triggered by a fast spin) — update the label and
      // remember the shape so it persists when leaving + returning to the page.
      onFacesChange(faces) { savedFaces = faces; updateShapeName(faces); },
      // Every shape has been seen — surface the hidden cube.
      onRubiksReveal() { revealRubiks(); },
    });
  } catch (e) {
    console.warn('[membrane] WebGL scene unavailable — rails/capture still live:', e);
    scene = { getFaces: () => null, resumeFromRubiks() {}, destroy() {} };
  }
  cp('membrane:after-createScene');
  updateShapeName(scene.getFaces());

  if (rubiksScrambleBtn) rubiksScrambleBtn.addEventListener('click', () => rubiks?.scramble());
  if (rubiksResetBtn) rubiksResetBtn.addEventListener('click', () => rubiks?.reset());
  renderAgenda();
  renderFeed();
  renderFieldFeed();

  const feedback = setupFeedbackBox(container);

  // Popover escape hatches — Esc always closes; a click anywhere outside the
  // panel and the rail closes ANY open panel, pinned or preview. Previews
  // normally close on their own grace timer, but that depends on a mouseleave
  // that the 60s rail rebuild can eat (innerHTML replaces the hovered row) —
  // when that happens the preview is stranded, and "click elsewhere" is the
  // gesture everyone reaches for. Both removed in destroy(); container
  // listeners would otherwise stack across re-mounts of this page.
  function onFeedPopKey(ev) {
    if (ev.key === 'Escape' && feedPopCat) { ev.stopPropagation(); closeFeedPop(); }
  }
  function onFeedPopOutside(ev) {
    if (!feedPopCat) return;
    if (ev.target.closest('.mfeed-pop') || ev.target.closest('.mfeed-category-row')) return;
    closeFeedPop();
  }
  document.addEventListener('keydown', onFeedPopKey);
  container.addEventListener('mousedown', onFeedPopOutside);

  return {
    setData(perBlobData) {
      if (perBlobData && perBlobData.events) eventsDataDay = localDayStamp();
      dataStore = { ...dataStore, ...perBlobData };
      renderAgenda();
      renderFeed();
      renderFieldFeed();
    },
    destroy() {
      // Gates the in-flight rubiks import continuation (see ensureRubiks) —
      // resolving after this point must NOT build the app on a dead canvas.
      membraneDestroyed = true;
      clearInterval(agendaTimer);
      clearTimeout(feedPopHideTimer);
      document.removeEventListener('keydown', onFeedPopKey);
      container.removeEventListener('mousedown', onFeedPopOutside);
      feedback.dispose();
      if (rubiks) rubiks.dispose();
      scene.destroy();
      container.classList.remove('membrane-host');
      container.classList.remove('membrane-hub');
      container.classList.remove('membrane-rubiks-active');
      container.innerHTML = '';
    },
  };
}
