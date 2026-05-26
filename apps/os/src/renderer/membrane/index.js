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
    const name = String(tpl(data) || id).trim();
    // Repeat the name around the ring with a separator so the big word
    // visibly orbits the orb. Reps scale to the name length so short names
    // ("asks") still fill the circumference without one giant gap.
    const unit = `${name}  ·  `;
    const reps = Math.max(3, Math.ceil(26 / unit.length));
    orbitalText.textContent = unit.repeat(reps);
    orbital.classList.add('is-visible');
  }

  // Stars now live in the 3D scene (starfield.js mounted in scene.js).
  // No more CSS box-shadow approach.
  updateOrbitalGeometry();
  const orbitalResize = new ResizeObserver(() => updateOrbitalGeometry());
  orbitalResize.observe(container);

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
      orbitalResize.disconnect();
      container.classList.remove('membrane-host');
      container.innerHTML = '';
    },
  };
}

export { BLOB_IDS, BLOB_PROFILES };
