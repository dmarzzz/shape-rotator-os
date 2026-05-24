import { createMembraneScene, SLOT_OFFSETS } from './scene.js';
import { createSoundDirector } from './sound.js';
import { BLOB_IDS, BLOB_PROFILES } from './blob.js';

// Orbital ring label per blob — tells you what's INSIDE each blob, not its
// internal metadata. Repeated twice on the path so the text wraps around
// the full circumference. Functions take live data and return the string.
function up(s) { return String(s ?? '').toUpperCase(); }

const ORBITAL_LABELS = {
  self: (d) => {
    const name = d.profile?.display_name || d.profile?.handle || d.profile?.record_id || 'unclaimed';
    const team = d.profile?.team || d.profile?.record_id;
    const edges = d.edgeCount ?? 0;
    const parts = [up(name)];
    if (team && team !== name) parts.push('TEAM ' + up(team));
    parts.push(`${edges} EDGES`);
    parts.push('YOUR SHAPE');
    return parts.join(' · ') + ' · ';
  },
  cohort: (d) => {
    const peers = d.peerCount ?? 0;
    const live = up(d.onlineCount || 'idle');
    return `${peers} PEERS · ${live} · YOUR CONSTELLATION · `;
  },
  events: (d) => {
    const next = d.nextEventLabel && d.nextEventLabel !== '—'
      ? up(d.nextEventLabel) : 'NO UPCOMING';
    const week = d.eventsThisWeek ?? 0;
    return `NEXT · ${next} · ${week} THIS WEEK · `;
  },
  asks: (d) => {
    const open = (d.asksList || []).filter(a => (a?.status || 'open') === 'open');
    const top = open.slice(0, 2).map(a => up(a.title || a.text || a.ask || 'untitled'));
    const titles = top.length > 0 ? top.join(' · ') : 'NONE OPEN';
    const count = d.openAskCount ?? open.length;
    return `${titles} · ${count} OPEN · `;
  },
};

// Per-blob panel content. `inline` renderer is called with (data) and
// returns the inline-content HTML. cohort intentionally keeps jump-only —
// user explicitly wants peer browsing in the legacy constellation view.
const PANEL_TEMPLATES = {
  self: {
    eyebrow: 'your shape',
    title: 'self',
    copy: 'this is your blob. it breathes with your activity. the contour bands drift with your work cadence; the rim warms when you are seen.',
    stats: [
      { key: 'tonic', val: 'D2 — 73.42 hz' },
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
      { key: 'tonic',  val: 'G2 — 97.99 hz' },
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
      { key: 'tonic',     val: 'A2 — 110.00 hz' },
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
      { key: 'tonic', val: 'F#2 — 92.50 hz' },
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
  const events = Array.isArray(data?.eventsList) ? data.eventsList : [];
  const now = Date.now();
  if (events.length === 0) {
    return `
      <section class="membrane-section">
        <header class="membrane-section-head">
          <h3 class="membrane-section-title">today</h3>
          <span class="membrane-section-count">0</span>
        </header>
        <p class="membrane-empty">no events on the calendar yet.</p>
      </section>`;
  }

  // Day windows for grouping. "Today" = anything on the calendar date today
  // OR scheduled within the next ~12h (covers late-night events that read
  // as "tonight"). "This week" = remaining 6 days. "Upcoming" = beyond.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const tomorrowMs = todayStartMs + 24 * 60 * 60 * 1000;
  const weekEndMs = todayStartMs + 7 * 24 * 60 * 60 * 1000;

  const parsed = events
    .map((e) => {
      const t = Date.parse(e?.starts_at || e?.start || e?.date || '');
      return Number.isFinite(t) ? { t, e } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);

  // Drop events from earlier than an hour ago (already happened).
  const live = parsed.filter((u) => u.t >= now - 60 * 60 * 1000);

  const today    = live.filter((u) => u.t < tomorrowMs);
  const thisWeek = live.filter((u) => u.t >= tomorrowMs && u.t < weekEndMs);
  const upcoming = live.filter((u) => u.t >= weekEndMs);

  function row(u, fmt) {
    const title = u.e.title || u.e.name || 'untitled';
    const loc = u.e.location || u.e.room || '';
    const isHappening = u.t <= now + 60 * 60 * 1000 && u.t >= now - 60 * 60 * 1000;
    const meta = loc || (isHappening ? 'happening' : fmtRel(u.t - now));
    return `
      <li class="membrane-event-row${isHappening ? ' membrane-event-now' : ''}">
        <span class="membrane-event-date">${escHtml(fmt(u.t))}</span>
        <span class="membrane-event-title">${escHtml(title)}</span>
        <span class="membrane-event-meta">${escHtml(meta)}</span>
      </li>`;
  }

  function section(title, rows, fmt, mod = '') {
    return `
      <section class="membrane-section${mod}">
        <header class="membrane-section-head">
          <h3 class="membrane-section-title">${title}</h3>
          <span class="membrane-section-count">${rows.length}</span>
        </header>
        ${rows.length === 0
          ? `<p class="membrane-empty">${title === 'today' ? 'nothing scheduled today.' : 'none.'}</p>`
          : `<ul class="membrane-event-list" role="list">${rows.map((u) => row(u, fmt)).join('')}</ul>`}
      </section>`;
  }

  // Always render TODAY (even if empty — emphasizes its importance). Only
  // render this-week and upcoming if they have content.
  const todayBlock = section('today', today, fmtTimeOnly, ' membrane-section-today');
  const weekBlock = thisWeek.length > 0 ? section('this week', thisWeek, fmtDayTime) : '';
  const upcomingBlock = upcoming.length > 0 ? section('upcoming', upcoming.slice(0, 16), fmtFullDate) : '';

  return todayBlock + weekBlock + upcomingBlock;
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

function renderSelfInline(data) {
  const profile = data?.profile || {};
  const name = profile.display_name || profile.name || profile.handle || 'unclaimed';
  const team = profile.team || profile.record_id || '';
  const edges = data?.edgeCount || '0';
  return `
    <section class="membrane-section">
      <header class="membrane-section-head">
        <h3 class="membrane-section-title">identity</h3>
      </header>
      <ul class="membrane-event-list" role="list">
        <li class="membrane-event-row">
          <span class="membrane-event-date">name</span>
          <span class="membrane-event-title">${escHtml(name)}</span>
          <span class="membrane-event-meta"></span>
        </li>
        ${team ? `
        <li class="membrane-event-row">
          <span class="membrane-event-date">team</span>
          <span class="membrane-event-title">${escHtml(team)}</span>
          <span class="membrane-event-meta"></span>
        </li>` : ''}
        <li class="membrane-event-row">
          <span class="membrane-event-date">edges</span>
          <span class="membrane-event-title">${escHtml(edges)} active</span>
          <span class="membrane-event-meta"></span>
        </li>
      </ul>
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
  return `
    <header class="membrane-panel-head">
      <span class="membrane-panel-eyebrow">${template.eyebrow}</span>
      <h2 class="membrane-panel-title">${template.title}</h2>
    </header>
    <p class="membrane-panel-note">${template.copy}</p>
    <ul class="membrane-panel-list" role="list">${renderStatList(template, data)}</ul>
    ${inlineHtml}
    <ul class="membrane-panel-actions" role="list">${renderActionList(template)}</ul>
  `;
}

export function mountMembrane(container, opts = {}) {
  console.log('[membrane] mounting into', container?.id || container?.className);
  container.classList.add('membrane-host');

  container.innerHTML = `
    <div class="membrane-stage">
      <div class="membrane-atmosphere" aria-hidden="true">
        <div class="ma-stars-fine"></div>
        <div class="ma-stars"></div>
        <div class="ma-throne-presence"></div>
      </div>
      <canvas class="membrane-canvas"></canvas>
      <svg class="throne-orbital" aria-hidden="true" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid meet">
        <defs>
          <path id="throne-orbital-path" d="M 200 200 m -180 0 a 180 180 0 1 1 360 0 a 180 180 0 1 1 -360 0" />
        </defs>
        <text>
          <textPath href="#throne-orbital-path" startOffset="0%" data-orbital-text></textPath>
        </text>
      </svg>
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
  const starsMain = container.querySelector('.ma-stars');
  const starsFine = container.querySelector('.ma-stars-fine');
  const orbital = container.querySelector('.throne-orbital');
  const orbitalText = container.querySelector('[data-orbital-text]');

  // Throne lives in screen space anchored to the bottom-right corner. The
  // orbital SVG follows the same anchor — these px values come from
  // SLOT_OFFSETS (world units) × pxPerWorld (canvas-height-derived). Same
  // math the scene uses; one source of truth.
  function updateOrbitalGeometry() {
    const rect = container.getBoundingClientRect();
    // halfHeight world units at z=0 with fov 38°, cameraZ 4.8 → tan(19°)*4.8
    const halfHeightWorld = Math.tan((38 * Math.PI / 180) / 2) * 4.8;
    const pxPerWorld = rect.height / (2 * halfHeightWorld);
    const throneRightPx  = SLOT_OFFSETS.throne.right  * pxPerWorld;
    const throneBottomPx = SLOT_OFFSETS.throne.bottom * pxPerWorld;
    const throneRadiusPx = SLOT_OFFSETS.throne.scale  * pxPerWorld;
    const orbitalRadiusPx = throneRadiusPx * 1.55;
    orbital.style.setProperty('--throne-right',  `${throneRightPx}px`);
    orbital.style.setProperty('--throne-bottom', `${throneBottomPx}px`);
    orbital.style.setProperty('--orbital-radius', `${orbitalRadiusPx}px`);
  }

  function setOrbitalForBlob(id) {
    const tpl = ORBITAL_LABELS[id];
    if (!tpl) return;
    const data = dataStore[id] || {};
    const label = tpl(data);
    // Repeat twice so the text wraps around the full circumference.
    orbitalText.textContent = label + label;
    orbital.classList.add('is-visible');
  }

  function generateStars() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const main = [];
    const mainCount = Math.round((w * h) / 14000);
    for (let i = 0; i < mainCount; i++) {
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * h);
      const op = (0.35 + Math.random() * 0.55).toFixed(2);
      const isBright = Math.random() < 0.12;
      const spread = isBright ? 0.6 : 0;
      const blur = isBright ? 1 : 0;
      main.push(`${x}px ${y}px ${blur}px ${spread}px rgba(255,255,255,${op})`);
    }
    starsMain.style.boxShadow = main.join(',');

    const fine = [];
    const fineCount = Math.round((w * h) / 4500);
    for (let i = 0; i < fineCount; i++) {
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * h);
      const op = (0.10 + Math.random() * 0.25).toFixed(2);
      fine.push(`${x}px ${y}px 0 0 rgba(255,255,255,${op})`);
    }
    starsFine.style.boxShadow = fine.join(',');
  }
  generateStars();
  updateOrbitalGeometry();
  const starResize = new ResizeObserver(() => {
    generateStars();
    updateOrbitalGeometry();
  });
  starResize.observe(container);

  let dataStore = {};

  function renderPanelFor(id) {
    const tpl = PANEL_TEMPLATES[id];
    if (!tpl) return;
    panel.dataset.activeBlob = id;
    panelContent.innerHTML = renderPanelInner(tpl, dataStore[id] || {});
    panelContent.scrollTop = 0;
    panelContent.querySelectorAll('[data-jump-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.jumpMode;
        if (!mode) return;
        if (typeof window.__srwkAlchemyJump === 'function') {
          window.__srwkAlchemyJump(mode);
        }
      });
    });
    dots.forEach((d) => {
      d.setAttribute('aria-pressed', d.dataset.blobJump === id ? 'true' : 'false');
    });
    // Orbital ring text — fade out → swap → fade in.
    orbital.classList.remove('is-visible');
    setTimeout(() => setOrbitalForBlob(id), 320);
  }

  const sound = createSoundDirector();

  const scene = createMembraneScene(canvas, {
    onActiveChange(id) {
      sound.setTonic(id);
      renderPanelFor(id);
    },
  });
  console.log('[membrane] scene mounted; blobs:', Object.keys(scene.blobs).join(','));

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
      }
    },
    sound,
    destroy() {
      scene.destroy();
      sound.destroy();
      starResize.disconnect();
      container.classList.remove('membrane-host');
      container.innerHTML = '';
    },
  };
}

export { BLOB_IDS, BLOB_PROFILES };
