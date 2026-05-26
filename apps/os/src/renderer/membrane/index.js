import { createMembraneScene, SLOT_OFFSETS } from './scene.js';
import { createSoundDirector } from './sound.js';
import { BLOB_IDS, BLOB_PROFILES } from './blob.js';

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
    copy: 'every peer in your circle perturbs this membrane. the surface is the network — swells are presence, the rim warms as more peers come online.',
    stats: [
      { key: 'peers',  val: '—', dataKey: 'peerCount' },
      { key: 'online', val: '—', dataKey: 'onlineCount' },
    ],
    // Cohort stays jump-only per user spec — peer browsing lives in legacy.
    inline: null,
    actions: [
      { label: 'open network →',       mode: 'constellation' },
      { label: 'every team + project', mode: 'shapes' },
    ],
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
      { key: 'open',  val: '—', dataKey: 'openAskCount' },
      { key: 'mine',  val: '—', dataKey: 'myAskCount' },
    ],
    inline: (data) => renderAsksInline(data),
    actions: [
      { label: 'open full asks board →', mode: 'asks' },
    ],
  },
};

// ─── per-blob inline renderers ──────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtRel(ms) {
  if (!Number.isFinite(ms)) return '';
  const abs = Math.abs(ms);
  const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
  if (abs < hr)  return `${Math.round(abs / min)}m ${ms < 0 ? 'ago' : 'from now'}`;
  if (abs < day) return `${Math.round(abs / hr)}h ${ms < 0 ? 'ago' : 'from now'}`;
  return `${Math.round(abs / day)}d ${ms < 0 ? 'ago' : 'from now'}`;
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
  const myHandle = (data?.myHandle || '').toLowerCase();
  const open = asks.filter((a) => (a?.status || 'open') === 'open');
  if (open.length === 0) {
    return `
      <section class="membrane-section">
        <header class="membrane-section-head">
          <h3 class="membrane-section-title">open</h3>
          <span class="membrane-section-count">0</span>
        </header>
        <p class="membrane-empty">no open asks. things are quiet.</p>
      </section>`;
  }
  const rows = open.slice(0, 24).map((a) => {
    const title = a.title || a.text || a.ask || 'untitled ask';
    const owner = a.owner || a.author || '';
    const isMine = owner.toLowerCase() === myHandle;
    const posted = a.posted_at || a.created_at;
    const postedT = posted ? Date.parse(posted) : null;
    const ago = Number.isFinite(postedT) ? fmtRel(postedT - Date.now()) : '';
    return `
      <li class="membrane-ask-row">
        <span class="membrane-ask-title">${escHtml(title)}</span>
        <span class="membrane-ask-meta">
          ${isMine ? '<span class="ask-status-mine">mine</span> · ' : ''}${escHtml(owner)}${ago ? ' · ' + escHtml(ago) : ''}
        </span>
      </li>`;
  }).join('');
  return `
    <section class="membrane-section">
      <header class="membrane-section-head">
        <h3 class="membrane-section-title">open</h3>
        <span class="membrane-section-count">${open.length}</span>
      </header>
      <ul class="membrane-ask-list" role="list">${rows}</ul>
    </section>`;
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
      <span class="cc-glyph" aria-hidden="true">◇</span>
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
        <span class="crewid-issuer">⬡ shape rotator · alchemy</span>
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

// ─── panel scaffolding ───────────────────────────────────────────────────

function renderStatList(template, data = {}) {
  return template.stats.map((s) => {
    const v = s.dataKey && data[s.dataKey] != null ? data[s.dataKey] : s.val;
    return `<li><span class="mpl-key">${s.key}</span><span class="mpl-val">${v}</span></li>`;
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
    <ul class="membrane-panel-actions" role="list">${renderActionList(template)}</ul>
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
            <span class="mst-glyph" aria-hidden="true">⌒</span>
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
    // Self gets a bespoke "crew credential" ID card; others use the
    // generic panel scaffolding.
    panelContent.innerHTML = id === 'self'
      ? renderSelfCard(dataStore[id] || {}, tpl)
      : renderPanelInner(tpl, dataStore[id] || {});
    panelContent.scrollTop = 0;
    // Cursor-tracked foil glint on the crew credential (settles flat).
    const crewid = panelContent.querySelector('.crewid');
    if (crewid) {
      crewid.addEventListener('pointermove', (e) => {
        const r = crewid.getBoundingClientRect();
        crewid.style.setProperty('--mx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
        crewid.style.setProperty('--my', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
        crewid.classList.add('is-foil');
      });
      crewid.addEventListener('pointerleave', () => crewid.classList.remove('is-foil'));
      // In-card "claim your credential" CTA → open the enrollment flow
      // (routes through the identity pill, which owns the modal).
      crewid.querySelector('[data-crewid-claim]')?.addEventListener('click', () => {
        document.getElementById('identity-pill')?.click();
      });
    }
    panelContent.querySelectorAll('[data-jump-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.jumpMode;
        if (!mode) return;
        if (typeof window.__srwkAlchemyJump === 'function') {
          window.__srwkAlchemyJump(mode);
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
  // Unclaimed = standing inside the ship: the panel (the seal + the claim
  // rite) shows over the galaxy "window". Striking your seal folds the
  // ship away → the orbs become the full-bleed world. Clicking an orb
  // summons its panel back as an overlay; clicking empty space folds it
  // away again.
  let folded = false;
  let entered = false; // crossed the threshold this session (claimed)
  function isClaimed() {
    const p = dataStore.self?.profile || {};
    return !!(p.record_id || p.handle || p.name || p.gh_handle);
  }
  function setFolded(f) {
    folded = !!f;
    container.classList.toggle('membrane-folded', folded);
  }
  // Explicit "fold away" control on the panel (besides clicking empty space).
  const foldBtn = document.createElement('button');
  foldBtn.className = 'membrane-fold-back';
  foldBtn.type = 'button';
  foldBtn.setAttribute('aria-label', 'fold away — back to the field');
  foldBtn.innerHTML = '<span aria-hidden="true">↩</span><span class="mfb-label">the field</span>';
  foldBtn.addEventListener('click', () => setFolded(true));
  panel.appendChild(foldBtn);

  const scene = createMembraneScene(canvas, {
    onActiveChange(id) {
      sound.setTonic(id);
      renderPanelFor(id);
    },
    // Tapping an orb in the folded full-bleed world summons its panel.
    onOrbOpen() { if (entered) setFolded(false); },
    // Clicking empty space (the void) folds the panel away again.
    onEmptyClick() { if (entered) setFolded(true); },
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
      if (entered) setFolded(false); // summon the panel out of the field
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
      // Once you're claimed you've crossed the threshold — the ship folds
      // away to the full-bleed field. Auto-folds once; you can summon/fold
      // panels freely after.
      if (!entered && isClaimed()) {
        entered = true;
        container.classList.add('membrane-can-fold');
        setTimeout(() => setFolded(true), 60);
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
