// ─── tabs.js — browser-style tabs for the whole OS ────────────────────────
//
// Every page is viewed inside a tab. A "tab" holds a *location* describing
// what the entire app is showing; switching tabs re-applies that location.
// Navigation that happens inside a tab (clicking the rail, opening a record,
// switching the top-level category) is captured back into the active tab via
// a MutationObserver on the datasets the app already maintains.
//
//   location = {
//     tab: "alchemy" | "apps" | "network" | "links",
//     mode?,        // OS sub-page when tab === "alchemy"
//     constellationMode?, // Constellation sub-view, e.g. "map" | "collab"
//     programPage?, // Program handbook page, e.g. "overview" | "success"
//     recordId?,    // an open record-detail page (alchemy)
//     appsView?,    // "atlas" | "easel"
//     netSub?,      // "network" | "metrics"
//     blank?: true  // a fresh empty tab
//   }

import * as Alchemy from "./alchemy.js";

const TABS_LS_KEY = "srwk:tabs_v1";

const MODE_LABEL = {
  membrane: "membrane", shapes: "cohort",
  constellation: "constellation", intel: "intel",
  calendar: "calendar", profile: "profile", onboarding: "onboarding",
  program: "program info", asks: "asks", context: "context", icons: "icons",
};

// Inner SVG markup for each page's Lucide icon (matches the left-nav rail).
const ICON_PATHS = {
  membrane: '<path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/><path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/><circle cx="12" cy="12" r="3"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/>',
  shapes: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  constellation: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  intel: '<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35"/><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67"/><path d="M12 18h.01"/><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67"/><circle cx="12" cy="12" r="2"/><path d="m13.41 10.59 5.66-5.66"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  profile: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  onboarding: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
  program: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  asks: '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  context: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  apps: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  network: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  links: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

function iconKey(loc) {
  if (!loc || loc.blank) return null;
  if (loc.tab === "alchemy") return loc.mode === "collab" ? "constellation" : (loc.mode || null);
  return loc.tab; // apps | network | links
}
function iconSVG(loc) {
  const inner = ICON_PATHS[iconKey(loc)];
  if (!inner) return "";
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
}

let tabs = [];          // [{ id, loc }]
let activeId = null;
let closed = [];        // stack of recently-closed locations (session only)
let seq = 1;
let suspendCapture = false;
let stripEl = null;
let menuEl = null;

function uid() { return "t" + Date.now().toString(36) + "_" + (seq++); }
function requestFrameOrTimeout(fn, timeoutMs = 80) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  try { requestAnimationFrame(run); } catch {}
  setTimeout(run, timeoutMs);
}

function normalizeLocation(loc) {
  if (!loc || loc.blank) return loc || { blank: true };
  if (loc.tab === "alchemy" && loc.mode === "collab") {
    return { ...loc, mode: "constellation", constellationMode: "collab" };
  }
  if (loc.tab === "alchemy" && loc.mode === "pulse") {
    const { constellationMode, ...rest } = loc;
    return { ...rest, mode: "shapes" };
  }
  return loc;
}

// ─── location helpers ─────────────────────────────────────────────────────
function currentAlchMode() {
  const av = document.getElementById("alchemy-view");
  return av ? (av.dataset.alchModeCurrent || null) : null;
}

function readCurrentLocation() {
  const top = document.body.dataset.activeTab || "alchemy";
  const loc = { tab: top };
  if (top === "alchemy") {
    const al = Alchemy.getLocation();
    loc.mode = al.mode;
    if (al.constellationMode) loc.constellationMode = al.constellationMode;
    if (al.programPage) loc.programPage = al.programPage;
    if (al.recordId) loc.recordId = al.recordId;
  } else if (top === "apps") {
    if (document.body.dataset.appsView) loc.appsView = document.body.dataset.appsView;
  } else if (top === "network") {
    loc.netSub = document.body.dataset.netSub || "network";
  }
  return loc;
}

function locTitle(loc) {
  if (!loc || loc.blank) return "new tab";
  if (loc.tab === "alchemy") {
    if (loc.recordId) return Alchemy.getRecordTitle(loc.recordId) || "record";
    if (loc.mode === "constellation" && loc.constellationMode === "collab") return "collab board";
    return MODE_LABEL[loc.mode] || "operating system";
  }
  if (loc.tab === "apps") return loc.appsView || "apps";
  if (loc.tab === "network") return loc.netSub === "metrics" ? "metrics" : "network";
  if (loc.tab === "links") return "links";
  return "tab";
}

// Drive the whole app to a location.
function applyLocation(loc) {
  loc = normalizeLocation(loc);
  suspendCapture = true;
  if (!loc || loc.blank) {
    document.body.dataset.blank = "1";
  } else {
    delete document.body.dataset.blank;
    if (loc.tab === "alchemy") {
      const wasAlchemy = document.body.dataset.activeTab === "alchemy";
      // instant: render synchronously with no cross-fade so the switch is
      // immediate like a browser tab.
      Alchemy.applyLocation({
        mode: loc.mode,
        constellationMode: loc.constellationMode,
        recordId: loc.recordId,
        programPage: loc.programPage,
        instant: true,
      });
      // Only flip the top-level tab if we weren't already on it — avoids a
      // redundant re-render when switching between two OS tabs.
      if (!wasAlchemy && typeof window.__srwkGoTab === "function") window.__srwkGoTab("alchemy");
    } else if (loc.tab === "apps") {
      if (loc.appsView && typeof window.__srwkOpenApp === "function") {
        window.__srwkOpenApp(loc.appsView);
      } else {
        delete document.body.dataset.appsView;
        if (typeof window.__srwkGoTab === "function") window.__srwkGoTab("apps");
      }
    } else if (loc.tab === "network") {
      if (typeof window.__srwkGoTab === "function") window.__srwkGoTab("network");
      if (typeof window.__srwkSetNetSub === "function") window.__srwkSetNetSub(loc.netSub || "network");
    } else if (loc.tab === "links") {
      if (typeof window.__srwkGoTab === "function") window.__srwkGoTab("links");
    }
  }
  // Release the capture guard once the resulting DOM mutations have settled.
  requestFrameOrTimeout(() => requestFrameOrTimeout(() => { suspendCapture = false; }));
}

// ─── tab operations ───────────────────────────────────────────────────────
function activate(id) {
  const t = tabs.find(x => x.id === id);
  if (!t) return;
  activeId = id;
  applyLocation(t.loc);
  renderStrip();
  save();
}

function newTab(loc, opts = {}) {
  const t = { id: uid(), loc: normalizeLocation(loc || { blank: true }) };
  if (opts.after) {
    const i = tabs.findIndex(x => x.id === activeId);
    tabs.splice(i < 0 ? tabs.length : i + 1, 0, t);
  } else {
    tabs.push(t);
  }
  if (opts.background) {
    renderStrip();
    save();
  } else {
    activate(t.id);
  }
  return t;
}

function closeTab(id) {
  const i = tabs.findIndex(x => x.id === id);
  if (i < 0) return;
  const [removed] = tabs.splice(i, 1);
  if (removed.loc && !removed.loc.blank) closed.push(removed.loc);
  if (tabs.length === 0) {
    const t = { id: uid(), loc: { blank: true } };
    tabs.push(t);
    activate(t.id);
    return;
  }
  if (activeId === id) {
    const next = tabs[Math.min(i, tabs.length - 1)];
    activate(next.id);
  } else {
    renderStrip();
    save();
  }
}

function reopenClosed() {
  const loc = closed.pop();
  if (loc) newTab(loc, { activate: true });
}

// Capture the live app state back into the active tab (fired by navigation).
function captureCurrent() {
  if (suspendCapture) return;
  const t = tabs.find(x => x.id === activeId);
  if (!t) return;
  if (document.body.dataset.blank) delete document.body.dataset.blank;
  t.loc = normalizeLocation(readCurrentLocation());
  renderStrip();
  save();
}

// ─── rendering ─────────────────────────────────────────────────────────────
function renderStrip() {
  if (!stripEl) return;
  stripEl.textContent = "";
  for (const t of tabs) {
    const chip = document.createElement("div");
    chip.className = "os-tab" + (t.id === activeId ? " is-active" : "");
    chip.dataset.tabId = t.id;
    chip.draggable = true;
    chip.title = locTitle(t.loc);

    const svg = iconSVG(t.loc);
    if (svg) {
      const icon = document.createElement("span");
      icon.className = "os-tab-icon";
      icon.innerHTML = svg; // static, app-controlled markup
      chip.appendChild(icon);
    }

    const title = document.createElement("span");
    title.className = "os-tab-title";
    title.textContent = locTitle(t.loc);

    const close = document.createElement("button");
    close.className = "os-tab-close";
    close.type = "button";
    close.setAttribute("aria-label", "close tab");
    close.textContent = "×";

    chip.appendChild(title);
    chip.appendChild(close);
    stripEl.appendChild(chip);
  }
  const plus = document.createElement("button");
  plus.className = "os-tab-new";
  plus.type = "button";
  plus.setAttribute("aria-label", "new tab");
  plus.textContent = "+";
  stripEl.appendChild(plus);
}

// ─── link interception (open in new tab) ───────────────────────────────────
function resolveNavTarget(el) {
  if (!el || !el.closest) return null;
  const rail = el.closest("[data-alch-mode]");
  if (rail) return { tab: "alchemy", mode: rail.dataset.alchMode };
  const cat = el.closest(".nav-cat[data-tab]");
  if (cat) return { tab: cat.dataset.tab };
  let alch = null;
  try { alch = Alchemy.getLocation?.(); } catch {}
  const alchMode = alch?.mode || currentAlchMode() || "shapes";
  const alchConstellationMode = alchMode === "constellation" ? (alch?.constellationMode || null) : null;
  const rec = el.closest("[data-record-id]");
  if (rec && rec.dataset.recordId) {
    const loc = { tab: "alchemy", mode: alchMode, recordId: rec.dataset.recordId };
    if (alchConstellationMode) loc.constellationMode = alchConstellationMode;
    return loc;
  }
  const person = el.closest("[data-person]");
  if (person && person.dataset.person) {
    const loc = { tab: "alchemy", mode: alchMode, recordId: person.dataset.person };
    if (alchConstellationMode) loc.constellationMode = alchConstellationMode;
    return loc;
  }
  return null;
}

function hideMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
}

function showContextMenu(x, y, loc) {
  hideMenu();
  menuEl = document.createElement("div");
  menuEl.className = "os-tab-ctxmenu";
  const item = document.createElement("button");
  item.type = "button";
  item.className = "os-tab-ctxitem";
  item.textContent = "Open in new tab";
  item.addEventListener("click", () => { hideMenu(); newTab(loc, { after: true, background: true }); });
  menuEl.appendChild(item);
  menuEl.style.left = x + "px";
  menuEl.style.top = y + "px";
  document.body.appendChild(menuEl);
  // Nudge back on-screen if it would overflow the right/bottom edge.
  const r = menuEl.getBoundingClientRect();
  if (r.right > window.innerWidth)  menuEl.style.left = (x - r.width) + "px";
  if (r.bottom > window.innerHeight) menuEl.style.top = (y - r.height) + "px";
}

// ─── wiring ─────────────────────────────────────────────────────────────────
function wireStrip() {
  let dragId = null;

  stripEl.addEventListener("click", (e) => {
    if (e.target.closest(".os-tab-new")) { newTab({ blank: true }); return; }
    const closeBtn = e.target.closest(".os-tab-close");
    if (closeBtn) {
      const chip = closeBtn.closest(".os-tab");
      if (chip) closeTab(chip.dataset.tabId);
      e.stopPropagation();
      return;
    }
    const chip = e.target.closest(".os-tab");
    if (chip && chip.dataset.tabId !== activeId) activate(chip.dataset.tabId);
  });

  // Hover the strip and scroll → move through the tabs horizontally. Most
  // wheels only emit vertical deltas, so fold deltaY into horizontal scroll.
  stripEl.addEventListener("wheel", (e) => {
    if (stripEl.scrollWidth <= stripEl.clientWidth) return; // nothing to scroll
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!delta) return;
    stripEl.scrollLeft += delta;
    e.preventDefault();
  }, { passive: false });

  // Middle-click a tab closes it (browser behavior).
  stripEl.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const chip = e.target.closest(".os-tab");
    if (chip) { e.preventDefault(); closeTab(chip.dataset.tabId); }
  });

  // Drag to reorder.
  stripEl.addEventListener("dragstart", (e) => {
    const chip = e.target.closest(".os-tab");
    if (!chip) return;
    dragId = chip.dataset.tabId;
    try { e.dataTransfer.effectAllowed = "move"; } catch {}
  });
  stripEl.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    const over = e.target.closest(".os-tab");
    if (!over || over.dataset.tabId === dragId) return;
    const from = tabs.findIndex(t => t.id === dragId);
    const to = tabs.findIndex(t => t.id === over.dataset.tabId);
    if (from < 0 || to < 0) return;
    const [m] = tabs.splice(from, 1);
    tabs.splice(to, 0, m);
    renderStrip();
  });
  stripEl.addEventListener("drop", (e) => { e.preventDefault(); dragId = null; save(); });
  stripEl.addEventListener("dragend", () => { dragId = null; save(); });
}

function wireGlobal() {
  // Middle-click a navigable link → open it in a background tab.
  document.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    if (e.target.closest(".os-tabs")) return; // handled by the strip
    const loc = resolveNavTarget(e.target);
    if (!loc) return;
    e.preventDefault();
    e.stopPropagation();
    newTab(loc, { after: true, background: true });
  }, true);

  // Right-click a navigable link → "Open in new tab" menu.
  document.addEventListener("contextmenu", (e) => {
    const loc = resolveNavTarget(e.target);
    if (!loc) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, loc);
  });
  document.addEventListener("click", (e) => {
    if (menuEl && !e.target.closest(".os-tab-ctxmenu")) hideMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    // Reopen last closed tab — ⌘/Ctrl+Shift+T.
    if (e.shiftKey && k === "t") { e.preventDefault(); reopenClosed(); return; }
    // New tab — ⌘/Ctrl+T or ⌘/Ctrl+N.
    if (!e.shiftKey && (k === "t" || k === "n")) { e.preventDefault(); newTab({ blank: true }); return; }
    // (⌘/Ctrl+W is intentionally NOT bound here — the native File menu owns
    //  it as "Close Window". Rewiring it to close-tab needs a menu change.)
    // Jump to tab N — ⌘/Ctrl+1..9 (9 = last tab, browser behavior).
    if (!e.shiftKey && k >= "1" && k <= "9") {
      const n = Number(k);
      const target = (n === 9) ? tabs[tabs.length - 1] : tabs[n - 1];
      if (target) { e.preventDefault(); activate(target.id); }
      return;
    }
  });
}

// ─── persistence ─────────────────────────────────────────────────────────────
function save() {
  try {
    localStorage.setItem(TABS_LS_KEY, JSON.stringify({
      tabs: tabs.map(t => ({ id: t.id, loc: t.loc })),
      activeId,
    }));
  } catch {}
}
function restore() {
  try {
    const raw = localStorage.getItem(TABS_LS_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
    tabs = data.tabs.map(t => ({ id: t.id || uid(), loc: normalizeLocation(t.loc || { blank: true }) }));
    activeId = (data.activeId && tabs.some(t => t.id === data.activeId)) ? data.activeId : tabs[0].id;
    return true;
  } catch { return false; }
}

export function init() {
  stripEl = document.getElementById("os-tabs");
  if (!stripEl) return;
  wireStrip();
  wireGlobal();

  if (restore()) {
    renderStrip();
    const t = tabs.find(x => x.id === activeId) || tabs[0];
    activeId = t.id;
    applyLocation(t.loc);
  } else {
    tabs = [{ id: uid(), loc: readCurrentLocation() }];
    activeId = tabs[0].id;
    renderStrip();
    save();
  }

  // Capture future navigation into the active tab. The app already mirrors
  // its location onto these datasets, so we just watch them.
  const obs = new MutationObserver(() => captureCurrent());
  obs.observe(document.body, { attributes: true, attributeFilter: ["data-active-tab", "data-apps-view", "data-net-sub"] });
  const av = document.getElementById("alchemy-view");
  if (av) obs.observe(av, { attributes: true, attributeFilter: ["data-alch-mode-current", "data-const-mode-current", "data-alch-program-page", "data-alch-detail"] });
}
