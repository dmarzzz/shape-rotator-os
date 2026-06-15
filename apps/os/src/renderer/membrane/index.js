import { createMembraneScene, CUBE_SCALE, MEMBRANE_FOV, MEMBRANE_CAMERA_Z } from './scene.js';
// NOTE: rubiks.js (+ its vendored GLTFLoader / cube-solver / postprocessing tree)
// is imported DYNAMICALLY in ensureRubiks(), NOT statically here. A static import
// would pull that whole subtree into boot.js's eager module graph, evaluated
// before boot() runs — keeping the easter egg off the boot critical path.
import { createSoundDirector } from './sound.js';
import { BLOB_IDS, BLOB_PROFILES, SHAPE_NAMES, TARGET_R } from './cube.js';

// World edge-length of the die's d6 (the cube shape the easter egg replaces):
// a unit BoxGeometry normalized to bounding-sphere TARGET_R, then group-scaled.
// The Rubik's cube body is matched to this — then bumped 20% larger by request.
const DIE_CUBE_EDGE = TARGET_R * (2 / Math.sqrt(3)) * CUBE_SCALE * 1.2;
import { askAgeLabel, askIsOpen, askStatus, askTopic, isAskMine, resolveAskAuthor, askVerbIconSvg, askVerbVars } from '../asks.js';

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
function dismissCard(el, done) {
  if (!el) { done?.(); return; }
  let reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {}
  el.classList.add('is-dismissing');
  el.style.pointerEvents = 'none';
  setTimeout(() => { try { el.remove(); } catch {} done?.(); }, reduce ? 0 : DISMISS_MS);
}

// Per-blob panel content. `inline` renderer is called with (data) and
// returns the inline-content HTML. cohort intentionally keeps jump-only —
// user explicitly wants peer browsing in the legacy constellation view.
const PANEL_TEMPLATES = {
  self: {
    eyebrow: 'your shape',
    // Title is the user's real name (falls back through the chain).
    title: (data) => {
      const p = data?.profile || {};
      return p.name || p.display_name || p.handle || p.gh_handle || 'unclaimed';
    },
    // No copy for self — the user's name + avatar are the identity.
    copy: '',
    // Avatar pinned to the top-right of the card, same row as the title.
    headAccessory: (data) => renderAvatar(data?.profile || {}),
    stats: [],
    inline: (data) => renderSelfInline(data),
    actions: [],
  },
  cohort: {
    eyebrow: 'the constellation',
    title: 'cohort',
    copy: 'every peer perturbs this membrane. pick a lens to read the network.',
    stats: [
      { key: 'peers',  val: '—', dataKey: 'peerCount' },
      { key: 'online', val: '—', dataKey: 'onlineCount' },
    ],
    // Each constellation lens + the full roster gets a real card you can
    // click — replaces the old hair-thin "open network →" links that were
    // lost in blank space. Wired in renderPanelFor via [data-const]/[data-shapes].
    inline: (data) => renderCohortViews(data),
    actions: [],
  },
  events: {
    eyebrow: 'who is here when',
    title: 'events',
    copy: 'time is the pressure here. a bright contour ring drifts toward now. past sessions recede as scars; upcoming as ridges building under the skin.',
    stats: [
      { key: 'this week', val: '—', dataKey: 'eventsThisWeek' },
    ],
    inline: (data) => renderEventsInline(data),
    actions: [
      { label: 'open full calendar →', mode: 'calendar' },
      { label: 'program info →',       mode: 'program' },
    ],
  },
  asks: {
    eyebrow: 'open pairings',
    title: 'asks',
    copy: 'each open ask is a bubbling point of pressure on the surface. fresh asks rise sharp; expiring asks sink back into the membrane.',
    stats: [
      { key: 'open',  val: '—', dataKey: 'openAskCount', details: (data) => renderAsksInline(data), open: true },
      { key: 'mine',  val: '—', dataKey: 'myAskCount' },
      { key: 'ask', label: 'post ask', mode: 'asks', opts: { openComposer: true } },
    ],
    inline: null,
    actions: [],
  },
};

// ─── per-blob inline renderers ──────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function isLinkBoundary(ch) {
  return !ch || !/[a-z0-9_-]/i.test(ch);
}

function renderEntityLink(entity, label) {
  return `<a class="membrane-entity-link" href="#${escHtml(entity.id)}" data-jump-profile="${escHtml(entity.id)}" data-jump-kind="${escHtml(entity.kind || '')}">${escHtml(label)}</a>`;
}

function renderLinkedText(text, entities = []) {
  const source = String(text || '');
  const options = [];
  const seen = new Set();

  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity?.id) continue;
    for (const label of [entity.label, entity.name, entity.id]) {
      const clean = String(label || '').trim();
      const key = clean.toLowerCase();
      if (clean.length < 3 || seen.has(key)) continue;
      seen.add(key);
      options.push({ entity, label: clean, lower: key });
    }
  }
  options.sort((a, b) => b.label.length - a.label.length);

  let out = '';
  let i = 0;
  let last = 0;
  const lower = source.toLowerCase();
  while (i < source.length) {
    const match = options.find((opt) =>
      lower.startsWith(opt.lower, i)
      && isLinkBoundary(source[i - 1])
      && isLinkBoundary(source[i + opt.label.length])
    );
    if (!match) { i += 1; continue; }
    out += escHtml(source.slice(last, i));
    out += renderEntityLink(match.entity, source.slice(i, i + match.label.length));
    i += match.label.length;
    last = i;
  }
  out += escHtml(source.slice(last));
  return out;
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
};
function feedIcon(kind) {
  const p = FEED_ICON_PATHS[kind];
  return p ? `<span class="mfeed-icon">${LUCIDE_OPEN}${p}</svg></span>` : '';
}

function fmtTimeOnly(t) {
  const d = new Date(t);
  const hr = d.getHours();
  const mn = String(d.getMinutes()).padStart(2, '0');
  const h12 = ((hr + 11) % 12) + 1;
  const ap = hr >= 12 ? 'pm' : 'am';
  return `${h12}:${mn}${ap}`;
}

function fmtDayTime(t) {
  const d = new Date(t);
  return `${WD[d.getDay()]} ${fmtTimeOnly(t)}`;
}

function fmtFullDate(t) {
  const d = new Date(t);
  const dy = String(d.getDate()).padStart(2, '0');
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${dy} · ${fmtTimeOnly(t)}`;
}

function renderEventsInline(data) {
  // Today-only. computeMembraneData (alchemy.js) builds `eventsToday` by
  // merging today's timed lines from the Phala calendar GRID (e.g. "19:00
  // muse dinner") with cohort.events spans overlapping today (e.g. daily
  // tea). We intentionally drop the this-week / upcoming sections — the
  // panel answers "what's on right now?" and the full schedule lives in
  // the calendar tab.
  const today = Array.isArray(data?.eventsToday) ? data.eventsToday : [];

  const rows = today.map((it) => {
    const dateLabel = it.time || (it.ongoing ? 'today' : '·');
    const meta = it.sub || (it.ongoing ? 'ongoing' : '');
    return `
      <li class="membrane-event-row">
        <span class="membrane-event-date">${escHtml(dateLabel)}</span>
        <span class="membrane-event-title">${escHtml(it.title || 'untitled')}</span>
        <span class="membrane-event-meta">${escHtml(meta)}</span>
      </li>`;
  }).join('');

  return `
    <section class="membrane-section membrane-section-today">
      <header class="membrane-section-head">
        <h3 class="membrane-section-title">today</h3>
        <span class="membrane-section-count">${today.length}</span>
      </header>
      ${today.length === 0
        ? `<p class="membrane-empty">nothing scheduled today.</p>`
        : `<ul class="membrane-event-list" role="list">${rows}</ul>`}
    </section>`;
}

function renderAsksInline(data) {
  const asks = Array.isArray(data?.asksList) ? data.asksList : [];
  const people = Array.isArray(data?.peopleList) ? data.peopleList : [];
  const askIdentity = { ...(data?.askIdentity || {}), people };
  const open = asks.filter(askIsOpen);
  if (open.length === 0) {
    return `
      <div class="membrane-open-asks">
        <p class="membrane-empty">no open asks. things are quiet.</p>
      </div>`;
  }
  const rows = open.slice(0, 24).map((a) => {
    const title = askTopic(a) || 'untitled ask';
    const author = resolveAskAuthor(a, people);
    const owner = author ? (author.name || author.record_id) : (a.author || a.owner || '');
    const mine = isAskMine(a, askIdentity);
    const ago = askAgeLabel(a);
    const verb = a.verb || 'ask';
    const verbGlyph = Array.from(String(verb).trim())[0] || '·';
    const verbVars = askVerbVars(verbGlyph);
    const status = askStatus(a);
    const statusBadge = status === 'open' && a._expired
      ? '<span class="membrane-ask-status membrane-ask-status-fading">fading</span>'
      : status !== 'open'
        ? `<span class="membrane-ask-status">${escHtml(status)}</span>`
        : '';
    const chips = (Array.isArray(a.skill_areas) ? a.skill_areas : [])
      .slice(0, 5)
      .map((s) => `<span class="membrane-ask-chip">${escHtml(s)}</span>`)
      .join('');
    return `
      <li class="membrane-ask-item" data-expired="${a._expired ? '1' : '0'}">
        <details class="membrane-ask-row">
          <summary class="membrane-ask-summary">
            <span class="membrane-ask-verb${verbVars ? ' has-verb-color' : ''}"${verbVars ? ` style="${verbVars}"` : ''} title="${escHtml(verb)}">${askVerbIconSvg(verbGlyph) || escHtml(verbGlyph)}</span>
            <span class="membrane-ask-body">
              <span class="membrane-ask-title">${escHtml(title)}</span>
              <span class="membrane-ask-meta">
                ${mine ? '<span class="ask-status-mine">mine</span> · ' : ''}${escHtml(owner)}${ago ? ' · ' + escHtml(ago) : ''}${statusBadge ? ' · ' + statusBadge : ''}
              </span>
            </span>
          </summary>
          <div class="membrane-ask-detail">
            ${chips ? `<div class="membrane-ask-chips">${chips}</div>` : ''}
          </div>
        </details>
      </li>`;
  }).join('');
  return `
    <div class="membrane-open-asks">
      <ul class="membrane-ask-list" role="list">${rows}</ul>
    </div>`;
}

// Tiny stable string hash for deterministic sigils (local; no crypto).
function sealHash(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || 'shape');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// A deterministic geometric SIGIL drawn from the seed — your "shape" as a
// mark (cypherpunk: key→glyph; new-age: a personal seal). Monochrome; the
// oxide stroke + a tiny hand-touched rotation come from CSS. Drawn inside a
// vesica frame by renderSeal().
function renderSigilSVG(seed) {
  let h = sealHash(seed);
  const rnd = () => { h = (Math.imul(h, 1664525) + 1013904223) >>> 0; return h / 4294967296; };
  const cx = 50, cy = 64, R = 21;
  const n = 5 + Math.floor(rnd() * 4); // 5–8 nodes
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
  }
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let d = '';
  order.forEach((idx, i) => { const [x, y] = pts[idx]; d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `; });
  d += 'Z';
  const dots = pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.7"/>`).join('');
  return `<svg class="seal-sigil" viewBox="0 0 100 128" aria-hidden="true"><path class="seal-sigil-line" d="${d}"/><g class="seal-sigil-dots">${dots}</g></svg>`;
}

// The seal: a vesica-piscis mandorla framing the identity mark. When the
// user is claimed + has an avatar, the avatar IS the charged seal (a face);
// otherwise their deterministic sigil sits inside, awaiting the strike.
function renderSeal(profile, seed) {
  const avatar = profile.avatarUrl || null;
  const inner = avatar
    ? `<img class="seal-face" style="clip-path:url(#seal-vesica-clip)" src="${escHtml(avatar)}" alt="" referrerpolicy="no-referrer"
         onerror="this.remove();this.parentElement.classList.add('no-face')" />`
    : '';
  return `
    <div class="seal ${avatar ? 'has-face' : 'no-face'}">
      <svg class="seal-vesica" viewBox="0 0 100 128" aria-hidden="true">
        <defs><clipPath id="seal-vesica-clip" clipPathUnits="objectBoundingBox">
          <path d="M.5 .04 C.2 .28 .2 .72 .5 .96 C.8 .72 .8 .28 .5 .04 Z"/>
        </clipPath></defs>
        <path class="seal-vesica-path" d="M50 6 C20 36 20 92 50 122 C80 92 80 36 50 6 Z"/>
      </svg>
      ${renderSigilSVG(seed)}
      ${inner}
    </div>`;
}

// Self profile as a SEAL — your shape as a sigil in a vesica, charged by
// your tonic. Claiming is a rite: strike your seal, cross the threshold.
// Blends shape-rotator geometry + alchemy + cypherpunk sovereignty +
// milady-intimate copy. (Container keeps .crewid for fill/foil/scan +
// the data-crewid-claim wiring.)
function renderSelfCard(data, tpl) {
  const profile = data?.profile || {};
  const connections = Array.isArray(data?.connections) ? data.connections : [];
  const name = profile.name || profile.display_name || profile.handle || profile.gh_handle || profile.record_id || 'unclaimed';
  const claimed = data?.claimed === true;
  const handle = profile.handle || profile.gh_handle || (profile.links && profile.links.github) || '';
  const role = profile.role || profile.title || (profile.is_mentor ? 'mentor' : '');
  const circle = profile.team || (profile.kind === 'team' ? profile.record_id : '') || '—';
  const edges = data?.edgeCount ?? 0;
  const seed = profile.record_id || handle || name;

  const readout = (k, v) => `<div class="crewid-row"><span class="crewid-k">${escHtml(k)}</span><span class="crewid-v">${escHtml(String(v))}</span></div>`;

  const commsRows = connections.slice(0, 24).map((c) => `
    <li class="crewid-comm" data-jump-profile="${escHtml(c.record_id)}" data-jump-kind="${escHtml(c.kind)}" tabindex="0" role="button" aria-label="open ${escHtml(c.name)}">
      <span class="crewid-comm-rel">${escHtml(c.edgeType || 'link')}</span>
      <span class="crewid-comm-name">${escHtml(c.name)}</span>
      <span class="crewid-comm-meta">${escHtml(c.team || c.role || '')}</span>
    </li>`).join('');

  // Unclaimed → nothing to edit; the primary move is the rite. Claimed →
  // full action set.
  const actions = (tpl?.actions || [])
    .filter((a) => claimed || a.mode !== 'profile')
    .map((a) => `<button type="button" class="crewid-action" data-jump-mode="${a.mode}">${a.label}</button>`).join('');
  const claimCta = claimed ? '' : `
    <button type="button" class="crewid-claim seal-strike" data-crewid-claim="1">
      <span class="cc-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"/><path d="M20 15.5a2.5 2.5 0 0 0-2.5-2.5h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1z"/><path d="M5 22h14"/></svg></span>
      <span class="cc-text">
        <span class="cc-title">strike your seal</span>
        <span class="cc-sub">identify · cross the threshold →</span>
      </span>
    </button>`;

  // One intimate line under the name — sincere, not winking.
  const tagline = claimed
    ? (role ? `${escHtml(role.toLowerCase())} · here` : 'here, and seen')
    : 'a shape not yet struck';

  return `
    <article class="crewid seal-card ${claimed ? 'is-claimed' : 'is-unclaimed'}">
      <div class="crewid-foil" aria-hidden="true"></div>
      <div class="crewid-scan" aria-hidden="true"></div>

      <div class="crewid-band">
        <span class="crewid-issuer"><svg class="issuer-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg> shape rotator · alchemy</span>
        <span class="crewid-doc">${claimed ? 'sealed' : 'unsealed'}</span>
      </div>

      <div class="seal-hero">
        ${renderSeal(profile, seed)}
        <span class="crewid-eyebrow">your shape</span>
        <h2 class="crewid-name">${escHtml(name)}</h2>
        <span class="seal-tagline">${escHtml(tagline)}</span>
        ${claimed && handle ? `<span class="seal-handle">@${escHtml(handle)}</span>` : ''}
      </div>

      ${claimCta}

      <div class="crewid-readouts seal-readouts">
        ${readout('edges', edges)}
        ${readout('circle', circle)}
      </div>

      <div class="crewid-comms">
        <div class="crewid-comms-head">
          <span class="crewid-comms-title">constellation</span>
          <span class="crewid-comms-count">${connections.length}</span>
        </div>
        ${connections.length === 0
          ? `<div class="crewid-empty"><span class="ce-status">∅</span><span class="ce-msg">no edges yet — once you join a circle, your shape finds its others.</span></div>`
          : `<ul class="crewid-comm-list" role="list">${commsRows}</ul>`}
      </div>

      <div class="seal-sovereign" aria-hidden="false">stored on this device · nothing leaves</div>

      <div class="crewid-actions">${actions}</div>
    </article>`;
}

function renderNetworkSection(data, connections = []) {
  const edgeCount = String(data?.edgeCount ?? connections.length ?? 0);
  const edgeSource = data?.edgeCountSource || (connections.length ? 'resolved self graph' : 'cohort graph');
  const connectionCount = connections.length;
  const tip = connectionCount > 0
    ? `${edgeCount} membrane edge${Number(edgeCount) === 1 ? '' : 's'}; ${connectionCount} named connection${connectionCount === 1 ? '' : 's'} available. source: ${edgeSource}.`
    : `${edgeCount} membrane edge${Number(edgeCount) === 1 ? '' : 's'}; no named connections resolved yet. source: ${edgeSource}.`;
  const countLabel = `${edgeCount} · ${connectionCount} connection${connectionCount === 1 ? '' : 's'}`;

  const ordered = [...connections].sort((a, b) => {
    const order = { 'teammate': 0, 'depends on': 1, 'depended by': 2 };
    return (order[a.edgeType] ?? 9) - (order[b.edgeType] ?? 9);
  });

  const connectionRows = ordered.slice(0, 24).map((c) => `
    <li class="membrane-event-row membrane-connection-row"
        data-jump-profile="${escHtml(c.record_id)}"
        data-jump-kind="${escHtml(c.kind)}"
        tabindex="0" role="button"
        aria-label="open ${escHtml(c.name)} in cohort view">
      <span class="membrane-event-date">${escHtml(c.edgeType)}</span>
      <span class="membrane-event-title">${escHtml(c.name)}</span>
      <span class="membrane-event-meta">${escHtml(c.team || c.role || '')}</span>
    </li>`).join('');

  const body = connectionCount === 0
    ? `<p class="membrane-network-empty">no named connections yet — once this profile resolves to teammates, dependencies, or a shared cluster, named records appear here.</p>`
    : `<ul class="membrane-event-list" role="list">${connectionRows}</ul>`;

  return `
    <details class="membrane-network">
      <summary class="membrane-network-summary">
        <span class="membrane-network-title">edges</span>
        <span class="membrane-network-count" data-tip="${escHtml(tip)}">${escHtml(countLabel)}</span>
      </summary>
      <div class="membrane-network-detail">
        ${body}
      </div>
    </details>`;
}

function renderSelfInline(data) {
  const profile = data?.profile || {};
  const connections = Array.isArray(data?.connections) ? data.connections : [];
  const read = data?.read || null;

  const team = profile.team || (profile.kind === 'team' ? profile.record_id : '') || '';
  const role = profile.role || profile.title || '';
  const handle = profile.handle || profile.gh_handle || '';
  const bio = profile.bio || profile.description || profile.about || '';
  const truncatedBio = bio.length > 300 ? bio.slice(0, 280).trim() + '…' : bio;

  // Identity meta strip — handle / team / role. Avatar + name already
  // live in the panel head; this is the "rest" of the identity stack.
  const metaRows = [];
  if (handle) {
    metaRows.push(`
      <li class="membrane-event-row">
        <span class="membrane-event-date">handle</span>
        <span class="membrane-event-title">@${escHtml(handle)}</span>
        <span class="membrane-event-meta">${escHtml(role)}</span>
      </li>`);
  }
  if (team) {
    metaRows.push(`
      <li class="membrane-event-row">
        <span class="membrane-event-date">team</span>
        <span class="membrane-event-title">${escHtml(team)}</span>
        <span class="membrane-event-meta"></span>
      </li>`);
  }

  const identityBlock = (metaRows.length > 0 || truncatedBio) ? `
    <section class="membrane-section">
      ${metaRows.length > 0 ? `<ul class="membrane-event-list" role="list">${metaRows.join('')}</ul>` : ''}
      ${truncatedBio ? `<p class="membrane-bio-line">${escHtml(truncatedBio)}</p>` : ''}
    </section>` : '';

  const readBlock = read?.text ? `
    <section class="membrane-section membrane-section-system">
      <header class="membrane-section-head">
        <h3 class="membrane-section-title"${read.sourceDetail ? ` title="${escHtml(read.sourceDetail)}"` : ''}>system read</h3>
      </header>
      <p class="membrane-system-line${read.tone === 'uncalibrated' ? ' is-uncalibrated' : ''}">${renderLinkedText(read.text, read.entities)}</p>
    </section>` : '';

  return renderNetworkSection(data, connections) + identityBlock + readBlock;
}

// Cohort panel = a set of lenses onto the network. Each is a real card
// (glyph + name + one-line read) that jumps into the constellation in that
// sub-view, plus one card for the full roster. The mini line-glyphs echo
// each lens's actual shape (overlapping circles = clusters, a small DAG =
// dependencies, a rising scatter = journey, a dot-grid = the roster).
const COHORT_VIEWS = [
  {
    nav: 'const', mode: 'clusters',
    title: 'clusters', desc: 'teams grouped by shared synergy',
    glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/><path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/></svg>',
  },
  {
    nav: 'const', mode: 'dependencies',
    title: 'dependencies', desc: 'who relies on whom',
    glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>',
  },
  {
    nav: 'const', mode: 'journey',
    title: 'journey', desc: 'every team’s PMF arc',
    glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>',
  },
  {
    nav: 'shapes',
    title: 'the full cohort', desc: 'every team + project, up close',
    glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></svg>',
  },
];

function renderCohortViews() {
  const cards = COHORT_VIEWS.map((v) => {
    const attr = v.nav === 'shapes' ? 'data-shapes="1"' : `data-const="${v.mode}"`;
    return `
      <button type="button" class="cohort-view-card" ${attr}>
        <span class="cvc-glyph" aria-hidden="true">${v.glyph}</span>
        <span class="cvc-text">
          <span class="cvc-title">${v.title}</span>
          <span class="cvc-desc">${v.desc}</span>
        </span>
        <span class="cvc-arrow" aria-hidden="true">→</span>
      </button>`;
  }).join('');
  return `<div class="cohort-view-grid">${cards}</div>`;
}

// ─── panel scaffolding ───────────────────────────────────────────────────

function renderStatList(template, data = {}) {
  return template.stats.map((s) => {
    const v = s.dataKey && data[s.dataKey] != null ? data[s.dataKey] : s.val;
    if (typeof s.details === 'function') {
      return `
        <li class="membrane-panel-list-details">
          <details class="mpl-details"${s.open ? ' open' : ''}>
            <summary class="mpl-details-summary">
              <span class="mpl-key">${escHtml(s.key)}</span>
              <span class="mpl-detail-meta">
                <span class="mpl-val">${escHtml(v)}</span>
                <span class="mpl-caret" aria-hidden="true"></span>
              </span>
            </summary>
            ${s.details(data)}
          </details>
        </li>`;
    }
    if (s.mode) {
      const opts = s.opts ? ` data-jump-opts="${escHtml(JSON.stringify(s.opts))}"` : '';
      return `
        <li class="membrane-panel-list-action">
          <button type="button" class="mpl-action" data-jump-mode="${escHtml(s.mode)}"${opts}>
            <span class="mpl-key">${escHtml(s.key)}</span>
            <span class="mpl-val">${escHtml(s.label || s.val || 'open')}</span>
          </button>
        </li>`;
    }
    return `<li><span class="mpl-key">${escHtml(s.key)}</span><span class="mpl-val">${escHtml(v)}</span></li>`;
  }).join('');
}

function renderActionList(template) {
  return template.actions.map((a) =>
    `<li><button type="button" class="mpa-btn" data-jump-mode="${a.mode}">${a.label}</button></li>`
  ).join('');
}

function renderPanelInner(template, data = {}) {
  const inlineHtml = template.inline ? template.inline(data) : '';
  const title = typeof template.title === 'function' ? template.title(data) : template.title;
  const accessory = template.headAccessory ? template.headAccessory(data) : '';
  const actionsHtml = renderActionList(template);
  const statsHtml = Array.isArray(template.stats) && template.stats.length
    ? `<ul class="membrane-panel-list" role="list">${renderStatList(template, data)}</ul>`
    : '';
  return `
    <header class="membrane-panel-head${accessory ? ' membrane-panel-head--with-accessory' : ''}">
      <div class="membrane-panel-head-text">
        <span class="membrane-panel-eyebrow">${template.eyebrow}</span>
        <h2 class="membrane-panel-title">${escHtml(title)}</h2>
      </div>
      ${accessory}
    </header>
    ${template.copy ? `<p class="membrane-panel-note">${template.copy}</p>` : ''}
    ${statsHtml}
    ${inlineHtml}
    ${actionsHtml ? `<ul class="membrane-panel-actions" role="list">${actionsHtml}</ul>` : ''}
  `;
}

// Avatar renderer — shared between the panel head and any other surface
// that wants the user's face. Falls back to initials when no GitHub link
// or the image fails (img onerror flips the parent data attribute).
function renderAvatar(profile) {
  const name = profile.name || profile.display_name || profile.handle || profile.gh_handle || '?';
  const avatarUrl = profile.avatarUrl || null;
  const initials = (name || '?')
    .split(/[\s_-]+/).map((s) => s[0] || '').filter(Boolean).slice(0, 2).join('').toUpperCase();
  if (avatarUrl) {
    return `
      <div class="membrane-avatar membrane-avatar--head" data-has-img="true">
        <img class="membrane-avatar-img"
             src="${escHtml(avatarUrl)}"
             alt="${escHtml(name)} avatar"
             onerror="this.parentElement.removeAttribute('data-has-img'); this.remove();" />
        <span class="membrane-avatar-initials" aria-hidden="true">${escHtml(initials)}</span>
      </div>`;
  }
  return `
    <div class="membrane-avatar membrane-avatar--head">
      <span class="membrane-avatar-initials" aria-hidden="true">${escHtml(initials)}</span>
    </div>`;
}

export function mountMembrane(container, opts = {}) {
  cp('membrane:mount-start');
  console.log('[membrane] mounting into', container?.id || container?.className);
  container.classList.add('membrane-host');
  // Always start showing the shapes, never the Rubik's cube — clear any stale
  // reveal state left on the (reused) container from a previous visit, so the
  // cube overlay and its Scramble/Reset controls don't linger after coming back.
  container.classList.remove('membrane-rubiks-active');
  // The panel is retired — start folded so it never flashes in before the
  // fold state below settles (see the "fold state" note further down).
  container.classList.add('membrane-folded');

  container.innerHTML = `
    <div class="membrane-stage">
      <div class="membrane-atmosphere" aria-hidden="true">
        <div class="ma-throne-presence"></div>
      </div>
      <!-- Not aria-hidden: these rails hold operable, labelled controls (open
           the calendar / a profile, dismiss). Hiding them from the a11y tree
           while leaving focusable buttons inside is a broken contract — they
           are named regions instead so keyboard/SR users reach them. -->
      <div class="membrane-agenda" data-agenda role="region" aria-label="today's agenda"></div>
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
      <aside class="membrane-panel" data-active-blob="self">
        <div class="membrane-panel-content"></div>
        <footer class="membrane-panel-foot">
          <div class="membrane-foot-left">
            <div class="membrane-blob-dots" role="tablist" aria-label="blobs">
              ${BLOB_IDS.map((id) => `
                <button type="button" class="membrane-blob-dot" data-blob-jump="${id}" aria-label="${BLOB_PROFILES[id].label}">
                  <span class="mbd-label">${BLOB_PROFILES[id].label}</span>
                </button>
              `).join('')}
              <button type="button" class="membrane-blob-dot membrane-footer-dot" data-footer-mode="profile" aria-label="edit profile">
                <span class="mbd-label">edit profile</span>
              </button>
              <button type="button" class="membrane-blob-dot membrane-footer-dot" data-footer-mode="onboarding" aria-label="onboarding">
                <span class="mbd-label">onboarding</span>
              </button>
            </div>
            <div class="membrane-field-row" data-membrane-field-row></div>
          </div>
          <button type="button" class="membrane-sound-toggle" data-membrane-sound aria-pressed="false">
            <span class="mst-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg></span>
            <span class="mst-label">hum</span>
            <span class="mst-state">off</span>
          </button>
        </footer>
      </aside>
    </div>
  `;

  const canvas = container.querySelector('.membrane-canvas');
  const panel = container.querySelector('.membrane-panel');
  const panelContent = container.querySelector('.membrane-panel-content');
  const soundToggle = container.querySelector('[data-membrane-sound]');
  const soundState = soundToggle.querySelector('.mst-state');
  const dots = container.querySelectorAll('.membrane-blob-dot');
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
  function renderAgenda() {
    if (!agendaEl) return;
    // Don't rebuild while a card is mid-recede — the once-a-minute timer or a
    // data load would otherwise snap the fold animation. The dismiss's own
    // completion calls renderAgenda() after the element is gone, so nothing is
    // lost by skipping here.
    if (agendaEl.querySelector('.is-dismissing')) return;
    const events = Array.isArray(dataStore.events?.eventsToday) ? dataStore.events.eventsToday : [];
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
    for (let h = Math.ceil(lo / 60); h <= Math.floor(hi / 60); h++) {
      ticks += `<div class="magenda-tick" style="top:${topPct(h * 60).toFixed(2)}%"><span class="magenda-tick-label">${pad2(h)}:00</span></div>`;
    }
    const rows = timed.map(({ e, start }) =>
      `<button type="button" class="magenda-event" data-cat="${agendaCat(e.title)}" style="top:${topPct(start).toFixed(2)}%">
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
      return `<div class="magenda-up" data-cat="${agendaCat(title)}">
        <button type="button" class="magenda-up-event" data-up-key="${ek}">
          <span class="magenda-event-title">${escHtml(title || 'untitled')}</span>${sub ? `<span class="magenda-event-time">${escHtml(sub)}</span>` : ''}
        </button>
        <button type="button" class="magenda-dismiss" data-dismiss-key="${ek}" aria-label="dismiss ${escHtml(title || 'event')}" title="dismiss">${DISMISS_X}</button>
      </div>`;
    };

    const todayEmpty = timed.length === 0;
    let html = '';
    // Today header — same chrome as the day headers below, with a "today"
    // prefix (from main). Keep the per-occurrence dateStr key on the card call
    // so same-day duplicate titles stay individually dismissable.
    html += `<div class="magenda-day-head">${escHtml(`today - ${WD[now.getDay()]} ${MO[now.getMonth()]} ${now.getDate()}`)}</div>`;
    // Today's all-day items as cards.
    for (const e of allDay) html += card(e.title, e.ongoing ? 'all day' : '', todayStr);
    // Today's timed events keep the time axis + now-line (only when present).
    if (!todayEmpty) html += `<div class="magenda-track">${ticks}${rows}${nowLine}</div>`;
    // Quiet note when today has nothing but there's a look-ahead.
    if (todayEmpty && !allDay.length && groups.length) html += `<div class="magenda-quiet">nothing today</div>`;
    // Upcoming, grouped by day.
    for (const g of groups) {
      html += `<div class="magenda-day-head">${escHtml(dayLabel(g.date))}</div>`;
      for (const it of g.items) html += card(it.title, it.time, g.date);
    }
    // Truly nothing on the horizon.
    if (todayEmpty && !allDay.length && !groups.length) html += `<div class="magenda-quiet">clear ahead</div>`;

    agendaEl.innerHTML = html;
  }
  const agendaTimer = setInterval(renderAgenda, 60 * 1000);
  // Clicking a dismiss control closes that notification; clicking the card
  // itself opens the calendar in a new OS tab (same as clicking through from
  // the calendar view).
  agendaEl?.addEventListener('click', (ev) => {
    const x = ev.target.closest('.magenda-dismiss');
    if (x) {
      ev.preventDefault();
      ev.stopPropagation();
      agendaDismissed.add(x.dataset.dismissKey);
      dismissCard(x.closest('.magenda-up'), () => renderAgenda());
      return;
    }
    if (!ev.target.closest('.magenda-up-event, .magenda-event')) return;
    if (typeof window.__srwkOpenInNewTab === 'function') {
      window.__srwkOpenInNewTab({ tab: 'alchemy', mode: 'calendar' });
    }
  });

  // "What's new" feed pinned to the LEFT edge, behind the cube — a mirror of
  // the agenda. Color-coded by kind (release / transcript / ask), minimal:
  // a colored dot, a short label, a relative age. Newest first.
  const feedEl = container.querySelector('[data-feed]');
  const feedDismissed = makeDismissStore('srwk:membrane:dismissed:feed');
  function feedAge(date) {
    const then = Date.parse(date);
    if (!Number.isFinite(then)) return '';
    const days = Math.floor((Date.now() - then) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return '1d';
    if (days < 7) return `${days}d`;
    return `${Math.floor(days / 7)}w`;
  }
  const feedKey = (it) => `${it.kind || ''}|${it.date || ''}|${it.label || ''}|${it.meta || ''}`;
  function renderFeed() {
    if (!feedEl) return;
    // Don't rebuild while a card is mid-recede (see renderAgenda).
    if (feedEl.querySelector('.is-dismissing')) return;
    // Transcript chips are hidden for now: they dead-end on the generic
    // context "raw" view (the session readouts aren't wired to a per-item
    // surface yet). Every other kind (release / ask / event) still shows.
    // Remove this filter once the readout → context deep-link lands.
    const keyN = new Map();
    const items = (Array.isArray(dataStore.feed) ? dataStore.feed : [])
      .filter((it) => it.kind !== 'transcript')
      // Attach a collision-proof dismiss key (occurrence ordinal for any
      // identical kind|date|label|meta), then drop the already-dismissed.
      .map((it) => {
        const base = feedKey(it);
        const n = keyN.get(base) || 0; keyN.set(base, n + 1);
        return { it, key: n ? `${base}#${n}` : base };
      })
      .filter(({ key }) => !feedDismissed.has(key));
    if (!items.length) { feedEl.innerHTML = ''; return; }
    // Each item is wrapped in a positioned row so a quiet dismiss control can
    // sit on the card's inner corner (hidden at rest, revealed on hover/focus
    // — the "subtle hidden feature" — see .mfeed-dismiss in membrane.css).
    feedEl.innerHTML = items.map(({ it, key }, i) => `
      <div class="mfeed-row">
        <button type="button" class="mfeed-item mfeed-${escHtml(it.kind)}" data-feed-i="${i}">
          ${feedIcon(it.kind)}
          <span class="mfeed-body">
            <span class="mfeed-label">${escHtml(it.label || '')}</span>
            <span class="mfeed-meta">${escHtml(it.meta || '')}</span>
          </span>
          <span class="mfeed-age">${escHtml(feedAge(it.date))}</span>
        </button>
        <button type="button" class="mfeed-dismiss" data-dismiss-key="${escHtml(key)}" aria-label="dismiss ${escHtml(it.label || 'notification')}" title="dismiss">${DISMISS_X}</button>
      </div>`).join('');
    feedEl.querySelectorAll('[data-feed-i]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const it = items[+btn.dataset.feedI]?.it;
        if (!it || !it.nav) return;
        if (typeof window.__srwkOpenInNewTab === 'function') {
          window.__srwkOpenInNewTab({ tab: 'alchemy', ...it.nav });
        }
      });
    });
    feedEl.querySelectorAll('.mfeed-dismiss').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // Record synchronously (by stable key, not list position) so a
        // re-render mid-animation can never resurrect the card.
        feedDismissed.add(btn.dataset.dismissKey);
        dismissCard(btn.closest('.mfeed-row'), () => renderFeed());
      });
    });
  }

  let dataStore = {};

  function renderPanelFor(id) {
    const tpl = PANEL_TEMPLATES[id];
    if (!tpl) return;
    panel.dataset.activeBlob = id;
    // Reverted the bespoke self "seal/credential" card — every blob now
    // uses the original generic panel scaffolding (header + stats + inline
    // + actions). Cleaner; the fold/field + claim modal stay.
    panelContent.innerHTML = renderPanelInner(tpl, dataStore[id] || {});
    panelContent.scrollTop = 0;
    panelContent.querySelectorAll('[data-jump-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.jumpMode;
        if (!mode) return;
        let opts = {};
        if (btn.dataset.jumpOpts) {
          try { opts = JSON.parse(btn.dataset.jumpOpts); } catch { opts = {}; }
        }
        if (typeof window.__srwkAlchemyJump === 'function') {
          window.__srwkAlchemyJump(mode, opts);
        }
      });
    });
    // Cohort view cards: a constellation lens (clusters/dependencies/journey)
    // or the full roster. Jump into the legacy surface on that view.
    panelContent.querySelectorAll('[data-const]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (typeof window.__srwkAlchemyJump === 'function') {
          window.__srwkAlchemyJump('constellation', { constellationMode: btn.dataset.const });
        }
      });
    });
    panelContent.querySelectorAll('[data-shapes]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (typeof window.__srwkAlchemyJump === 'function') {
          window.__srwkAlchemyJump('shapes');
        }
      });
    });
    panelContent.querySelectorAll('[data-crewid-claim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (typeof window.__srwkOpenIdentityFlow === 'function') {
          window.__srwkOpenIdentityFlow();
        } else if (typeof window.__srwkAlchemyJump === 'function') {
          window.__srwkAlchemyJump('profile');
        }
      });
    });
    // Connection rows: click jumps to that peer's detail page in the
    // legacy cohort (shapes) view.
    panelContent.querySelectorAll('[data-jump-profile]').forEach((row) => {
      const fire = (ev) => {
        ev?.preventDefault?.();
        const id = row.dataset.jumpProfile;
        if (!id) return;
        if (typeof window.__srwkAlchemyShowRecord === 'function') {
          window.__srwkAlchemyShowRecord(id, 'shapes');
        }
      };
      row.addEventListener('click', fire);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { fire(ev); }
      });
    });
    dots.forEach((d) => {
      d.setAttribute('aria-pressed', d.dataset.blobJump === id ? 'true' : 'false');
    });
  }

  const sound = createSoundDirector();

  // ── fold state ───────────────────────────────────────────────────────
  // The membrane is now a pure ambient view. The old self/cohort/events/asks
  // panel is retired as a pop-up — identity lives in profile › "your seal",
  // and the other lenses are reached through the alchemy rail menu. So the
  // panel starts folded for EVERYONE and never un-folds (the void-click
  // summon is gone — see the scene wiring below). The panel DOM is kept but
  // permanently hidden; its machinery stays valid for any external repaint.
  let folded = true;
  let didAutoField = true; // never auto-enter again — we already start folded
  function setFolded(f) {
    folded = !!f;
    container.classList.toggle('membrane-folded', folded);
  }
  function maybeAutoEnterField() {
    if (didAutoField) return;
    if (!dataStore.self || dataStore.self.claimed !== true) return;
    didAutoField = true;
    setFolded(true);
  }
  // Explicit "enter the field" control in the panel footer.
  const foldBtn = document.createElement('button');
  foldBtn.className = 'membrane-enter-field';
  foldBtn.type = 'button';
  foldBtn.setAttribute('aria-label', 'enter the field — fold the panel away');
  foldBtn.innerHTML = '<span class="mef-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></span><span class="mef-label">enter the field</span>';
  foldBtn.addEventListener('click', () => setFolded(true));
  const panelFoot = panel.querySelector('.membrane-panel-foot');
  const fieldRow = panel.querySelector('[data-membrane-field-row]');
  (fieldRow || panelFoot || panel).prepend(foldBtn);

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
  function ensureRubiks() {
    if (rubiks) return Promise.resolve(rubiks);
    if (!rubiksLoading) {
      rubiksLoading = import('./rubiks.js').then(({ createRubiksApp }) => {
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
  const scene = createMembraneScene(canvas, {
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
  cp('membrane:after-createScene');
  updateShapeName(scene.getFaces());

  if (rubiksScrambleBtn) rubiksScrambleBtn.addEventListener('click', () => rubiks?.scramble());
  if (rubiksResetBtn) rubiksResetBtn.addEventListener('click', () => rubiks?.reset());
  renderAgenda();
  renderFeed();
  console.log('[membrane] scene mounted; cube active:', scene.getActiveBlobId());

  sound.setTonic('self');
  renderPanelFor('self');

  soundToggle.addEventListener('click', () => {
    const next = !sound.isEnabled();
    sound.setEnabled(next);
    soundToggle.setAttribute('aria-pressed', String(next));
    soundState.textContent = next ? 'on' : 'off';
  });
  container.querySelectorAll('[data-footer-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.footerMode;
      if (!mode) return;
      if (typeof window.__srwkAlchemyJump === 'function') {
        window.__srwkAlchemyJump(mode);
      }
    });
  });

  dots.forEach((dot) => {
    dot.addEventListener('click', () => {
      const id = dot.dataset.blobJump;
      if (!id) return;
      scene.setActiveBlob(id);
      sound.setTonic(id);
      renderPanelFor(id);
      if (folded) setFolded(false); // summon the panel out of the field
    });
  });

  return {
    setActiveBlob(id) {
      scene.setActiveBlob(id);
      sound.setTonic(id);
      renderPanelFor(id);
    },
    getActiveBlob: () => scene.getActiveBlobId(),
    setData(perBlobData) {
      dataStore = { ...dataStore, ...perBlobData };
      maybeAutoEnterField();
      renderAgenda();
      renderFeed();
      const active = scene.getActiveBlobId();
      if (active) renderPanelFor(active);
    },
    sound,
    destroy() {
      clearInterval(agendaTimer);
      if (rubiks) rubiks.dispose();
      scene.destroy();
      sound.destroy();
      container.classList.remove('membrane-host');
      container.classList.remove('membrane-rubiks-active');
      container.innerHTML = '';
    },
  };
}

export { BLOB_IDS, BLOB_PROFILES };
