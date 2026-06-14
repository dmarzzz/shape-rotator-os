// ─── find.js — global search overlay (⌘/Ctrl+F) + new-tab launcher ──────────
//
// Two surfaces, one engine:
//   1. A drop-down search panel anchored to the top-right corner, opened with
//      ⌘/Ctrl+F. It has a scope toggle:
//        • "this page" — native-style find-in-page: highlights matching text
//          in the visible content, Enter cycles between matches.
//        • "global"    — searches the whole cohort (teams, projects, people)
//          plus the OS pages / tabs, showing live results you can click to
//          navigate to.
//   2. A centred search bar shown on a fresh "new tab" (body[data-blank]),
//      always in global mode, that surfaces live results as you type — a
//      lightweight launcher for jumping straight to a project, person or page.
//
// This module owns ⌘/Ctrl+F globally (capture-phase, ahead of the network
// graph filter in boot.js). The graph filter input stays usable by click.

import { getCohortSurface } from "./cohort-source.js";
import { buildCohortIndex } from "./cohort-relations.js";

const SCOPE_LS_KEY = "srwk:find_scope_v1";
const MAX_RESULTS = 40;

// Chrome we never search/highlight when finding text in the active page.
const CHROME_SELECTOR =
  ".os-find, .os-find-blank, #primary-nav, #tab-bar, #content-top, #blank-tab," +
  " script, style, noscript, select, textarea, input";

const TYPE_LABEL = {
  team: "team", project: "project", person: "person",
  page: "page", section: "section",
};

let cohortIndex = null;     // built from the cohort surface (async)
let catalog = [];           // flattened searchable entities, rebuilt on open
let scope = "global";       // "global" | "page"

// overlay refs
let overlayEl, inputEl, counterEl, prevEl, nextEl, resultsEl, scopeBtns = [];
// blank-tab refs
let blankInputEl, blankResultsEl;

// find-in-page state
const pageFind = { marks: [], idx: -1 };

// ─── data ────────────────────────────────────────────────────────────────
async function loadCohort() {
  try {
    const surface = await getCohortSurface();
    cohortIndex = buildCohortIndex(surface);
  } catch { /* keep whatever we had; page-find still works */ }
}

// Flatten everything searchable into a uniform list. Cheap to rebuild — the
// cohort is ~100 records — so we refresh it each time a surface opens.
function buildCatalog() {
  const items = [];
  if (cohortIndex) {
    for (const t of cohortIndex.teams) {
      if (!t || !t.record_id) continue;
      const kind = t.kind === "project" ? "project" : "team";
      items.push({
        type: kind,
        title: t.name || t.record_id,
        sub: t.focus || t.domain || (t.membership ? `${t.membership} ${kind}` : kind),
        hay: [t.name, t.record_id, t.focus, t.domain, t.traction, t.now]
          .filter(Boolean).join(" ").toLowerCase(),
        nav: () => {
          window.__srwkGoTab?.("alchemy");
          window.__srwkAlchemyShowRecord?.(t.record_id, "shapes");
        },
      });
    }
    for (const p of cohortIndex.people) {
      if (!p || !p.record_id) continue;
      const team = cohortIndex.teamLabel(p.team);
      items.push({
        type: "person",
        title: p.name || p.record_id,
        sub: [p.role, team && team !== "—" ? team : null].filter(Boolean).join(" · "),
        hay: [p.name, p.record_id, p.role, p.geo, p.domain, team]
          .filter(Boolean).join(" ").toLowerCase(),
        nav: () => {
          window.__srwkGoTab?.("alchemy");
          window.__srwkAlchemyShowRecord?.(p.record_id, "shapes");
        },
      });
    }
  }
  // OS pages (left rail) — lets you launch straight to calendar/context/etc.
  document.querySelectorAll(".alchemy-rail-btn[data-alch-mode]").forEach((btn) => {
    const mode = btn.dataset.alchMode;
    const label = btn.querySelector(".ar-label")?.textContent?.trim() || mode;
    const hint = btn.querySelector(".ar-hint")?.textContent?.trim() || "";
    items.push({
      type: "page", title: label, sub: hint,
      hay: `${label} ${hint} ${mode}`.toLowerCase(),
      nav: () => { window.__srwkGoTab?.("alchemy"); window.__srwkAlchemyJump?.(mode); },
    });
  });
  // In-page views folded into the cohort + context pages (2026-06). They no
  // longer have rail buttons, so list them here to keep "constellation",
  // "collab board", and "intel" launchable from search.
  const FOLDED_VIEWS = [
    { title: "constellation", sub: "cohort · relationship map", hay: "constellation map shared edges relationships cohort", jump: ["constellation", { constellationMode: "map" }] },
    { title: "pmf evidence", sub: "cohort · journey view", hay: "journey pmf evidence product market fit cohort", jump: ["constellation", { constellationMode: "journey" }] },
    { title: "product layer", sub: "cohort · stack view", hay: "stack product layer cohort", jump: ["constellation", { constellationMode: "stack" }] },
    { title: "collab board", sub: "cohort · seek ↔ offer · intros", hay: "collab board collaboration intros seek offer matrix cohort", jump: ["constellation", { constellationMode: "collab" }] },
    { title: "intel signals", sub: "context · vault-backed cohort moves", hay: "intel signals vault moves reads context", jump: ["context", { contextView: "signals" }] },
    { title: "intel data", sub: "context · sanitized entity graph", hay: "intel data entities graph grounding context", jump: ["context", { contextView: "data" }] },
  ];
  for (const v of FOLDED_VIEWS) {
    items.push({
      type: "page", title: v.title, sub: v.sub,
      hay: `${v.title} ${v.sub} ${v.hay}`.toLowerCase(),
      nav: () => { window.__srwkGoTab?.("alchemy"); window.__srwkAlchemyJump?.(v.jump[0], v.jump[1]); },
    });
  }
  // Top-level sections (operating system / apps / network / links).
  document.querySelectorAll(".nav-cat[data-tab]").forEach((btn) => {
    const tab = btn.dataset.tab;
    const label = btn.querySelector(".nav-cat-label")?.textContent?.trim() || tab;
    items.push({
      type: "section", title: label, sub: "",
      hay: `${label} ${tab}`.toLowerCase(),
      nav: () => window.__srwkGoTab?.(tab),
    });
  });
  // Links — demoted from the nav rail to a footer chip (2026-06), but still
  // a top-level destination, so keep it launchable from search.
  items.push({
    type: "section", title: "links", sub: "handouts · repos · downloads",
    hay: "links handouts repos downloads workspace external",
    nav: () => window.__srwkGoTab?.("links"),
  });
  return items;
}

function scoreCatalog(q) {
  const ql = q.trim().toLowerCase();
  if (!ql) return [];
  const scored = [];
  for (const it of catalog) {
    const t = it.title.toLowerCase();
    let score = -1;
    if (t === ql) score = 0;
    else if (t.startsWith(ql)) score = 1;
    else if (t.includes(ql)) score = 2;
    else if (it.hay.includes(ql)) score = 3;
    if (score >= 0) scored.push({ it, score });
  }
  scored.sort((a, b) => a.score - b.score || a.it.title.localeCompare(b.it.title));
  return scored.slice(0, MAX_RESULTS).map((s) => s.it);
}

// ─── results list (shared by overlay + blank tab) ──────────────────────────
// Wires an <input> to a results container: live rendering, ↑/↓ to move the
// active row, Enter to pick. Returns nothing — purely side-effecting.
function attachListSearch(input, container) {
  let active = -1;

  const rows = () => Array.from(container.querySelectorAll(".os-find-result"));
  const setActive = (i) => {
    const list = rows();
    if (!list.length) { active = -1; return; }
    active = (i + list.length) % list.length;
    list.forEach((r, j) => r.classList.toggle("is-active", j === active));
    list[active].scrollIntoView({ block: "nearest" });
  };

  const render = () => {
    const q = input.value;
    container.textContent = "";
    active = -1;
    if (!q.trim()) return;
    const items = scoreCatalog(q);
    if (!items.length) {
      const none = document.createElement("p");
      none.className = "os-find-empty";
      none.textContent = `no matches for “${q.trim()}”`;
      container.appendChild(none);
      return;
    }
    items.forEach((it, i) => {
      const row = document.createElement("button");
      row.className = "os-find-result";
      row.type = "button";
      row.setAttribute("role", "option");

      const tag = document.createElement("span");
      tag.className = "ofr-type";
      tag.dataset.type = it.type;
      tag.textContent = TYPE_LABEL[it.type] || it.type;

      const main = document.createElement("span");
      main.className = "ofr-main";
      const title = document.createElement("span");
      title.className = "ofr-title";
      title.textContent = it.title;
      main.appendChild(title);
      if (it.sub) {
        const sub = document.createElement("span");
        sub.className = "ofr-sub";
        sub.textContent = it.sub;
        main.appendChild(sub);
      }

      row.appendChild(tag);
      row.appendChild(main);
      row.addEventListener("mousemove", () => setActive(i));
      row.addEventListener("click", () => { it.nav(); closeOverlay(); });
      container.appendChild(row);
    });
    setActive(0);
  };

  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    const list = rows();
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = list[active] || list[0];
      if (pick) pick.click();
    }
  });

  return { render };
}

// ─── find-in-page (scope: this page) ───────────────────────────────────────
function isVisible(el) {
  if (!el) return false;
  if (el.closest("[hidden]")) return false;
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function clearPageMarks() {
  for (const m of pageFind.marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  }
  pageFind.marks = [];
  pageFind.idx = -1;
}

function highlightInTextNode(textNode, ql) {
  const text = textNode.nodeValue;
  const lower = text.toLowerCase();
  let idx = lower.indexOf(ql);
  if (idx === -1) return;
  const frag = document.createDocumentFragment();
  let from = 0;
  while (idx !== -1) {
    if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
    const mark = document.createElement("mark");
    mark.className = "os-find-hl";
    mark.textContent = text.slice(idx, idx + ql.length);
    frag.appendChild(mark);
    pageFind.marks.push(mark);
    from = idx + ql.length;
    idx = lower.indexOf(ql, from);
  }
  if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
  textNode.parentNode.replaceChild(frag, textNode);
}

function pageSearch(rawQuery) {
  clearPageMarks();
  const ql = (rawQuery || "").trim().toLowerCase();
  if (!ql) { updateCounter(0, 0); return; }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || p.closest(CHROME_SELECTOR)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.toLowerCase().includes(ql)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  // Mutate after walking so we don't invalidate the walker mid-traversal.
  for (const t of targets) highlightInTextNode(t, ql);

  if (pageFind.marks.length) { pageFind.idx = 0; focusMark(0); }
  else updateCounter(0, 0);
}

function focusMark(i) {
  pageFind.marks.forEach((m, j) => m.classList.toggle("is-current", j === i));
  const m = pageFind.marks[i];
  if (m) m.scrollIntoView({ block: "center", behavior: "smooth" });
  updateCounter(pageFind.marks.length ? i + 1 : 0, pageFind.marks.length);
}

function cycleMark(dir) {
  if (!pageFind.marks.length) return;
  pageFind.idx = (pageFind.idx + dir + pageFind.marks.length) % pageFind.marks.length;
  focusMark(pageFind.idx);
}

function updateCounter(cur, total) {
  if (!counterEl) return;
  const show = scope === "page";
  counterEl.hidden = !show;
  // Only offer the prev/next cycle controls when there's more than one match.
  if (prevEl) prevEl.hidden = !show || total < 2;
  if (nextEl) nextEl.hidden = !show || total < 2;
  counterEl.textContent = `${cur} / ${total}`;
  counterEl.classList.toggle("zero", total === 0);
}

// ─── scope ──────────────────────────────────────────────────────────────────
function setScope(next) {
  scope = next === "page" ? "page" : "global";
  try { localStorage.setItem(SCOPE_LS_KEY, scope); } catch {}
  scopeBtns.forEach((b) => b.setAttribute("aria-selected", b.dataset.scope === scope ? "true" : "false"));
  overlayEl.dataset.scope = scope;
  // Re-run the current query under the new scope.
  const q = inputEl.value;
  clearPageMarks();
  if (scope === "page") {
    resultsEl.textContent = "";
    pageSearch(q);
  } else {
    updateCounter(0, 0);
    if (counterEl) counterEl.hidden = true;
    overlayList.render();
  }
  inputEl.focus();
}

// ─── overlay open/close ──────────────────────────────────────────────────────
let overlayList = null;

// Open the overlay with a query prefilled — the quick dial's search rail
// hands off here. Exported alongside init(); same overlay, same catalog.
export function openWithQuery(query = null) {
  openOverlay();
  if (inputEl && query != null) {
    inputEl.value = String(query);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function openOverlay() {
  if (!overlayEl) return;
  catalog = buildCatalog();
  overlayEl.dataset.open = "true";
  overlayEl.setAttribute("aria-hidden", "false");
  // Re-apply scope so placeholder/results/counter line up, then focus.
  setScope(scope);
  requestAnimationFrame(() => { inputEl.focus(); inputEl.select(); });
  loadCohort().then(() => { catalog = buildCatalog(); if (scope === "global") overlayList.render(); });
}

function closeOverlay() {
  if (!overlayEl || overlayEl.dataset.open !== "true") return;
  overlayEl.dataset.open = "false";
  overlayEl.setAttribute("aria-hidden", "true");
  clearPageMarks();
}

function toggleOverlay() {
  if (overlayEl.dataset.open === "true") {
    if (document.activeElement !== inputEl) { inputEl.focus(); inputEl.select(); }
    else closeOverlay();
  } else {
    openOverlay();
  }
}

// ─── DOM construction ─────────────────────────────────────────────────────────
const SEARCH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></svg>';

function buildOverlay() {
  overlayEl = document.createElement("div");
  overlayEl.className = "os-find";
  overlayEl.id = "os-find";
  overlayEl.dataset.open = "false";
  overlayEl.dataset.scope = scope;
  overlayEl.setAttribute("role", "dialog");
  overlayEl.setAttribute("aria-label", "search");
  overlayEl.setAttribute("aria-hidden", "true");
  overlayEl.innerHTML = `
    <div class="os-find-bar">
      <span class="os-find-icon">${SEARCH_ICON}</span>
      <input class="os-find-input" type="text" autocomplete="off" spellcheck="false" placeholder="" aria-label="search" />
      <button class="os-find-prev" type="button" hidden aria-label="previous match" title="previous match (Shift+Enter)">‹</button>
      <button class="os-find-counter" type="button" hidden title="next match (Enter)"></button>
      <button class="os-find-next" type="button" hidden aria-label="next match" title="next match (Enter)">›</button>
    </div>
    <div class="os-find-scope" role="tablist" aria-label="search scope">
      <button class="os-find-scope-btn" type="button" data-scope="page" role="tab">this page</button>
      <button class="os-find-scope-btn" type="button" data-scope="global" role="tab">global</button>
    </div>
    <div class="os-find-results" role="listbox"></div>`;
  document.body.appendChild(overlayEl);

  inputEl = overlayEl.querySelector(".os-find-input");
  counterEl = overlayEl.querySelector(".os-find-counter");
  prevEl = overlayEl.querySelector(".os-find-prev");
  nextEl = overlayEl.querySelector(".os-find-next");
  resultsEl = overlayEl.querySelector(".os-find-results");
  scopeBtns = Array.from(overlayEl.querySelectorAll(".os-find-scope-btn"));

  overlayList = attachListSearch(inputEl, resultsEl);

  // Scope toggle.
  scopeBtns.forEach((b) => b.addEventListener("click", () => setScope(b.dataset.scope)));

  // Input drives page-find when in page scope (list mode handled by attachListSearch).
  inputEl.addEventListener("input", () => { if (scope === "page") pageSearch(inputEl.value); });
  inputEl.addEventListener("keydown", (e) => {
    if (scope === "page" && e.key === "Enter") { e.preventDefault(); cycleMark(e.shiftKey ? -1 : 1); }
  });

  counterEl.addEventListener("click", () => cycleMark(1));
  nextEl.addEventListener("click", () => cycleMark(1));
  prevEl.addEventListener("click", () => cycleMark(-1));
}

function buildBlankBar() {
  const host = document.getElementById("blank-tab");
  if (!host) return;
  const wrap = document.createElement("div");
  wrap.className = "os-find-blank";
  wrap.innerHTML = `
    <div class="os-find-blank-bar">
      <span class="os-find-icon">${SEARCH_ICON}</span>
      <input class="os-find-blank-input" type="text" autocomplete="off" spellcheck="false" placeholder="" aria-label="search" />
    </div>
    <div class="os-find-blank-results" role="listbox"></div>`;
  // Insert above the existing "new tab — pick a page" hint.
  host.insertBefore(wrap, host.firstChild);

  blankInputEl = wrap.querySelector(".os-find-blank-input");
  blankResultsEl = wrap.querySelector(".os-find-blank-results");
  const list = attachListSearch(blankInputEl, blankResultsEl);

  // Focus + refresh whenever a blank tab becomes the active tab.
  const obs = new MutationObserver(() => {
    if (document.body.hasAttribute("data-blank")) {
      catalog = buildCatalog();
      list.render();
      requestAnimationFrame(() => blankInputEl.focus());
      loadCohort().then(() => { catalog = buildCatalog(); list.render(); });
    } else {
      blankInputEl.value = "";
    }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ["data-blank"] });
}

// ─── keyboard ─────────────────────────────────────────────────────────────────
function wireKeys() {
  // Capture phase + stopImmediatePropagation so we own ⌘/Ctrl+F ahead of the
  // network graph filter's handler in boot.js.
  document.addEventListener("keydown", (e) => {
    const isModF = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
    if (!isModF) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toggleOverlay();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (overlayEl && overlayEl.dataset.open === "true") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeOverlay();
    }
  }, true);

  // Click anywhere outside the panel → fade it out.
  document.addEventListener("mousedown", (e) => {
    if (!overlayEl || overlayEl.dataset.open !== "true") return;
    if (e.target.closest(".os-find")) return;
    closeOverlay();
  });
}

export function init() {
  try { scope = localStorage.getItem(SCOPE_LS_KEY) === "page" ? "page" : "global"; } catch {}
  buildOverlay();
  buildBlankBar();
  wireKeys();
  loadCohort();
}
