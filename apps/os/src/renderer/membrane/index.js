import { createMembraneScene, SLOT_OFFSETS } from './scene.js';
import { createSoundDirector } from './sound.js';
import { BLOB_IDS, BLOB_PROFILES } from './blob.js';
import { askAgeLabel, askIsOpen, askStatus, askTopic, isAskMine, resolveAskAuthor, askVerbIconSvg, askVerbVars } from '../asks.js';

function up(s) { return String(s ?? '').toUpperCase(); }

// Orbital ring NAME per blob — the big word that orbits the focused orb.
// self resolves to the claimed handle/name (e.g. "dmarz"), or "self" when
// unclaimed; the others are their fixed names. setOrbitalForBlob() repeats
// the name around the ring so it reads as the orb's identity orbiting it.
const ORBITAL_LABELS = {
  self: (d) => {
    const p = d.profile || {};
    return p.display_name || p.name || p.handle || p.gh_handle
        || (p.links && p.links.github) || p.record_id || 'self';
  },
  cohort: () => 'cohort',
  events: () => 'events',
  asks:   () => 'asks',
};

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
    stats: [
      { key: 'edges', val: '—', dataKey: 'edgeCount' },
    ],
    inline: (data) => renderSelfInline(data),
    actions: [
      { label: 'edit profile →', mode: 'profile' },
      { label: 'onboarding →',   mode: 'onboarding' },
    ],
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

const WD = ['sun','mon','tue','wed','thu','fri','sat'];
const MO = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

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
  const claimed = !!(profile.record_id || profile.handle || profile.name || profile.gh_handle);
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

function renderSelfInline(data) {
  const profile = data?.profile || {};
  const connections = Array.isArray(data?.connections) ? data.connections : [];

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

  if (connections.length === 0) {
    return identityBlock + `
      <section class="membrane-section">
        <header class="membrane-section-head">
          <h3 class="membrane-section-title">connections</h3>
          <span class="membrane-section-count">0</span>
        </header>
        <p class="membrane-empty">no edges yet — once you join a team and declare dependencies, your constellation lights up.</p>
      </section>`;
  }

  // Group connections by edgeType so similar relationships cluster.
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

  return identityBlock + `
    <section class="membrane-section">
      <header class="membrane-section-head">
        <h3 class="membrane-section-title">connections</h3>
        <span class="membrane-section-count">${connections.length}</span>
      </header>
      <ul class="membrane-event-list" role="list">${connectionRows}</ul>
    </section>`;
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
  return `
    <header class="membrane-panel-head${accessory ? ' membrane-panel-head--with-accessory' : ''}">
      <div class="membrane-panel-head-text">
        <span class="membrane-panel-eyebrow">${template.eyebrow}</span>
        <h2 class="membrane-panel-title">${escHtml(title)}</h2>
      </div>
      ${accessory}
    </header>
    ${template.copy ? `<p class="membrane-panel-note">${template.copy}</p>` : ''}
    <ul class="membrane-panel-list" role="list">${renderStatList(template, data)}</ul>
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
  console.log('[membrane] mounting into', container?.id || container?.className);
  container.classList.add('membrane-host');

  container.innerHTML = `
    <div class="membrane-stage">
      <div class="membrane-atmosphere" aria-hidden="true">
        <div class="ma-throne-presence"></div>
      </div>
      <canvas class="membrane-canvas"></canvas>
      <svg class="throne-orbital" aria-hidden="true" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet">
        <defs>
          <!-- Horizontal ellipse so the name orbits left↔right around the orb's
               middle (not top↔bottom). The word scrolls along it via the
               startOffset animation added in setOrbitalForBlob(). -->
          <path id="throne-orbital-path" d="M 8,200 a 192,76 0 1,1 384,0 a 192,76 0 1,1 -384,0" />
        </defs>
        <text>
          <textPath href="#throne-orbital-path" startOffset="0%" data-orbital-text></textPath>
        </text>
      </svg>
      <div class="membrane-sat-labels" aria-hidden="true">
        <span class="membrane-sat-label" data-slot="home_a"></span>
        <span class="membrane-sat-label" data-slot="home_b"></span>
        <span class="membrane-sat-label" data-slot="home_c"></span>
      </div>
      <aside class="membrane-panel" data-active-blob="self">
        <div class="membrane-panel-content"></div>
        <footer class="membrane-panel-foot">
          <button type="button" class="membrane-sound-toggle" data-membrane-sound aria-pressed="false">
            <span class="mst-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/></svg></span>
            <span class="mst-label">hum</span>
            <span class="mst-state">off</span>
          </button>
          <div class="membrane-blob-dots" role="tablist" aria-label="blobs">
            ${BLOB_IDS.map((id) => `
              <button type="button" class="membrane-blob-dot" data-blob-jump="${id}" aria-label="${BLOB_PROFILES[id].label}">
                <span class="mbd-label">${BLOB_PROFILES[id].label}</span>
              </button>
            `).join('')}
          </div>
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
  const orbital = container.querySelector('.throne-orbital');
  const orbitalText = container.querySelector('[data-orbital-text]');
  const satLabelEls = {};
  container.querySelectorAll('.membrane-sat-label').forEach((el) => { satLabelEls[el.dataset.slot] = el; });

  // Resolve a blob's short display name (self → claimed handle or "self").
  function blobName(id) {
    const tpl = ORBITAL_LABELS[id];
    return String((tpl ? tpl(dataStore[id] || {}) : id) || id).trim();
  }

  // px-per-world at z=0 (fov 38°, cameraZ 4.8). Same math the scene uses to
  // place blobs — one source of truth so overlays track the 3D orbs exactly.
  function pxPerWorld(rect) {
    const halfHeightWorld = Math.tan((38 * Math.PI / 180) / 2) * 4.8;
    return rect.height / (2 * halfHeightWorld);
  }

  // Throne lives in screen space anchored to the bottom-right corner. The
  // orbital SVG follows the same anchor.
  function updateOrbitalGeometry() {
    const rect = container.getBoundingClientRect();
    const ppw = pxPerWorld(rect);
    const throneRightPx  = SLOT_OFFSETS.throne.right  * ppw;
    const throneBottomPx = SLOT_OFFSETS.throne.bottom * ppw;
    const throneRadiusPx = SLOT_OFFSETS.throne.scale  * ppw;
    const orbitalRadiusPx = throneRadiusPx * 1.55;
    orbital.style.setProperty('--throne-right',  `${throneRightPx}px`);
    orbital.style.setProperty('--throne-bottom', `${throneBottomPx}px`);
    orbital.style.setProperty('--orbital-radius', `${orbitalRadiusPx}px`);
    updateSatelliteLabels(rect, ppw);
  }

  // Background orbs get a static name label pinned just under each so you
  // know what you're clicking. Text = the blob currently in that home slot
  // (slots are fixed screen positions; the blob in each changes on swap).
  function updateSatelliteLabels(rect = container.getBoundingClientRect(), ppw = pxPerWorld(rect)) {
    for (const slotName of ['home_a', 'home_b', 'home_c']) {
      const el = satLabelEls[slotName];
      const off = SLOT_OFFSETS[slotName];
      if (!el || !off) continue;
      const id = BLOB_IDS.find((b) => scene.slotFor && scene.slotFor(b) === slotName);
      if (!id) { el.style.opacity = '0'; continue; }
      const cx = rect.width - off.right * ppw;
      const cy = rect.height - off.bottom * ppw;
      const r = off.scale * ppw;
      el.textContent = blobName(id);
      el.style.left = `${cx}px`;
      el.style.top = `${cy + r + 7}px`;
      el.style.opacity = '1';
    }
  }

  function setOrbitalForBlob(id) {
    const tpl = ORBITAL_LABELS[id];
    if (!tpl) return;
    const name = blobName(id);
    // Repeat the name around the ellipse with a separator so the big word
    // fills the ring; reps scale to the name length.
    const unit = `${name}  ·  `;
    const reps = Math.max(4, Math.ceil(40 / unit.length));
    orbitalText.textContent = unit.repeat(reps);
    // (Re)attach the scroll animation — setting textContent wipes children.
    // Scrolling startOffset negative drags the word leftward around the
    // horizontal ellipse → it orbits left↔right across the orb's front.
    const NS = 'http://www.w3.org/2000/svg';
    const anim = document.createElementNS(NS, 'animate');
    anim.setAttribute('attributeName', 'startOffset');
    anim.setAttribute('from', '0%');
    anim.setAttribute('to', '-100%');
    anim.setAttribute('dur', '52s');
    anim.setAttribute('repeatCount', 'indefinite');
    orbitalText.appendChild(anim);
    orbital.classList.add('is-visible');
  }

  // Orbital geometry init + ResizeObserver are set up AFTER `scene` exists
  // (updateSatelliteLabels reads scene.slotFor) — see below the scene mount.
  let orbitalResize = null;

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
    // Connection rows: click jumps to that peer's detail page in the
    // legacy cohort (shapes) view.
    panelContent.querySelectorAll('[data-jump-profile]').forEach((row) => {
      const fire = () => {
        const id = row.dataset.jumpProfile;
        if (!id) return;
        if (typeof window.__srwkAlchemyShowRecord === 'function') {
          window.__srwkAlchemyShowRecord(id, 'shapes');
        }
      };
      row.addEventListener('click', fire);
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fire(); }
      });
    });
    dots.forEach((d) => {
      d.setAttribute('aria-pressed', d.dataset.blobJump === id ? 'true' : 'false');
    });
    // Orbital ring text — fade out → swap → fade in.
    orbital.classList.remove('is-visible');
    setTimeout(() => { setOrbitalForBlob(id); updateSatelliteLabels(); }, 320);
  }

  const sound = createSoundDirector();

  // ── fold state ───────────────────────────────────────────────────────
  // Two homes, gated on whether you've claimed your shape:
  //   • UNCLAIMED → the panel is home (the "wall with a window" — the claim
  //     surface). Never auto-fold; an unclaimed user stranded in an empty
  //     field has no way to claim.
  //   • CLAIMED → the field is home. On first data load we fold the wall
  //     away once so a returning member lands among the orbs. Tapping an orb
  //     summons its panel back; tapping the void folds away again.
  // The claimed signal comes from self.claimed (a FORMAL identity claim only)
  // so the github editor user is never mistaken for claimed.
  let folded = false;
  let didAutoField = false;
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
  (panelFoot || panel).appendChild(foldBtn);

  const scene = createMembraneScene(canvas, {
    onActiveChange(id) {
      sound.setTonic(id);
      renderPanelFor(id);
    },
    // From the field, tapping an orb summons its panel back.
    onOrbOpen() { if (folded) setFolded(false); },
    // Tapping empty space (the void) folds the panel away again.
    onEmptyClick() { setFolded(true); },
  });
  console.log('[membrane] scene mounted; blobs:', Object.keys(scene.blobs).join(','));

  // Now that `scene` exists (updateSatelliteLabels reads scene.slotFor),
  // do the initial geometry pass + keep it synced on resize.
  updateOrbitalGeometry();
  orbitalResize = new ResizeObserver(() => updateOrbitalGeometry());
  orbitalResize.observe(container);

  sound.setTonic('self');
  renderPanelFor('self');

  soundToggle.addEventListener('click', () => {
    const next = !sound.isEnabled();
    sound.setEnabled(next);
    soundToggle.setAttribute('aria-pressed', String(next));
    soundState.textContent = next ? 'on' : 'off';
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
      for (const id of BLOB_IDS) {
        if (perBlobData?.[id] && scene.blobs[id]?.setData) {
          scene.blobs[id].setData(perBlobData[id]);
        }
      }
      const active = scene.getActiveBlobId();
      if (active) {
        renderPanelFor(active);
        // Refresh the orbital text in place when underlying data changes
        // (no fade — data refresh shouldn't feel like a swap).
        setOrbitalForBlob(active);
        updateSatelliteLabels();
      }
    },
    sound,
    destroy() {
      scene.destroy();
      sound.destroy();
      orbitalResize?.disconnect();
      container.classList.remove('membrane-host');
      container.innerHTML = '';
    },
  };
}

export { BLOB_IDS, BLOB_PROFILES };
