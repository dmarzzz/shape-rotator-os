import { renderCohortCard, mountShapesIn, escHtml, escAttr, normalizeLinkHref, buildEditPRUrl } from "@shape-rotator/shape-ui";

// Membership taxonomy — mirrored from apps/os/src/renderer/alchemy.js so the
// web surface filters the same way the Electron app does. The cohort chip is
// the default so visitors land on the formally-invited cohort first (per the
// coordinator's note about not implying a 1-in-30 invite rate when the formal
// cohort is 1-in-7).
const TEAM_CHIPS = [
  { id: "cohort",   label: "cohort teams",  match: (t) => (t.membership || "visiting") === "cohort" },
  { id: "visiting", label: "visiting",      match: (t) => (t.membership || "visiting") !== "cohort" },
  { id: "all",      label: "all",           match: () => true },
];
const PERSON_CHIPS = [
  { id: "cohort-member",    label: "cohort members",    match: (p) => (p.role_class || "visiting-scholar") === "cohort-member" },
  { id: "visiting-scholar", label: "visiting scholars", match: (p) => (p.role_class || "visiting-scholar") === "visiting-scholar" },
  { id: "coordinator",      label: "coordinators",      match: (p) => (p.role_class || "visiting-scholar") === "coordinator" },
  { id: "all",              label: "all",               match: () => true },
];

const state = {
  kind: "works",                  // "works" (teams) | "people"
  membership: "cohort",           // chip id from the active chip set
  detail: null,                   // record_id of the currently-open detail, or null
};

// Detail routing uses location.hash so a profile URL is shareable + the
// browser back button works without extra wiring. Format: #<record_id>.
function parseDetailHash() {
  const h = (typeof location !== "undefined" ? location.hash : "") || "";
  return h.startsWith("#") ? decodeURIComponent(h.slice(1)) || null : null;
}

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }

  const teams = cohort.teams || [];
  const people = cohort.people || [];

  // Build the toolbar shell once; rerender just the grid on chip clicks.
  mount.innerHTML = `
    <nav class="cohort-filter" role="tablist" aria-label="filter by kind">
      <button class="cohort-chip" data-kind="works" type="button" aria-selected="true">teams &amp; projects <span class="cohort-chip-count">${teams.length}</span></button>
      <button class="cohort-chip" data-kind="people" type="button" aria-selected="false">individuals <span class="cohort-chip-count">${people.length}</span></button>
    </nav>
    <nav class="cohort-filter cohort-filter-membership" role="tablist" aria-label="filter by membership"></nav>
    <div id="cohort-grid" class="cohort-grid"></div>
    <div id="cohort-detail" class="cohort-detail" hidden></div>
  `;
  const filterRows = mount.querySelectorAll(".cohort-filter");
  const membershipNav = mount.querySelector(".cohort-filter-membership");
  const grid = mount.querySelector("#cohort-grid");
  const detailHost = mount.querySelector("#cohort-detail");

  function activeChipSet() {
    return state.kind === "people" ? PERSON_CHIPS : TEAM_CHIPS;
  }

  function findRecord(recordId) {
    return teams.find(t => t.record_id === recordId)
        || people.find(p => p.record_id === recordId)
        || null;
  }

  function renderGrid() {
    const chipSet = activeChipSet();
    if (!chipSet.some(c => c.id === state.membership)) state.membership = chipSet[0].id;
    const source = state.kind === "people" ? people : teams;
    const counts = new Map(chipSet.map(c => [c.id, source.filter(c.match).length]));
    membershipNav.innerHTML = chipSet.map(chip => `
      <button class="cohort-chip cohort-chip-membership" data-membership="${chip.id}" type="button" aria-selected="${chip.id === state.membership}">${chip.label} <span class="cohort-chip-count">${counts.get(chip.id) || 0}</span></button>
    `).join("");
    for (const btn of membershipNav.querySelectorAll(".cohort-chip[data-membership]")) {
      btn.addEventListener("click", () => {
        if (btn.dataset.membership === state.membership) return;
        state.membership = btn.dataset.membership;
        renderGrid();
      });
    }

    const active = chipSet.find(c => c.id === state.membership) || chipSet[0];
    const records = source.filter(active.match);
    grid.innerHTML = "";
    if (!records.length) {
      grid.innerHTML = `<p class="page-empty">no ${active.label} yet.</p>`;
    } else {
      for (const rec of records) {
        try {
          const card = renderCohortCard(rec, {
            onClick: (_e, _el) => {
              const id = rec.record_id;
              if (id) location.hash = `#${encodeURIComponent(id)}`;
            },
          });
          if (card instanceof Node) grid.appendChild(card);
        } catch (e) { console.warn("[cohort] card render failed:", rec.record_id, e); }
      }
    }

    requestAnimationFrame(() => {
      try { mountShapesIn(mount); }
      catch (e) { console.warn("[cohort] shape mount failed:", e); }
    });
  }

  // Detail view. Mirrors the OS app's openDetail() pattern (renderTeamDetail
  // / renderPersonDetail in apps/os/src/renderer/alchemy.js) at a fraction
  // of the LOC — the OS uses 250+ lines of templated HTML with subsystem
  // classes that don't exist on web. This is a focused, web-native variant
  // built on the same data shape with the same primary affordances:
  // back-link, hero (name + focus + shape canvas), metadata strip, links,
  // and (for teams) the member roster as clickable sub-cards.
  function renderDetailLinks(links = {}) {
    const entries = Object.entries(links).filter(([, v]) => v && String(v).trim());
    if (!entries.length) return "";
    const rows = [];
    for (const [k, v] of entries) {
      const href = normalizeLinkHref(k, v);
      const display = String(v).replace(/^https?:\/\//, "");
      if (href) {
        rows.push(`<li><a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer"><span class="cd-link-k">${escHtml(k)}</span><span class="cd-link-v">${escHtml(display)}</span></a></li>`);
      } else {
        rows.push(`<li><span class="cd-link-k">${escHtml(k)}</span><span class="cd-link-v">${escHtml(display)}</span></li>`);
      }
    }
    return `<ul class="cd-links">${rows.join("")}</ul>`;
  }

  function teamKind(t) {
    if (!t) return "team";
    const k = String(t.kind || "team").toLowerCase();
    return k === "project" ? "project" : "team";
  }

  function renderDetail(rec) {
    const isTeam = (rec.kind || "team") !== "person" && !rec.role_class;
    const editUrl = buildEditPRUrl
      ? buildEditPRUrl({ recordType: isTeam ? "team" : "person", recordId: rec.record_id })
      : `https://github.com/dmarzzz/shape-rotator-os/blob/main/cohort-data/${isTeam ? "teams" : "people"}/${rec.record_id}.md`;
    const shapeFam = Number(rec.shape_fam ?? rec.shape ?? 0) || 0;
    const shapeKind = isTeam ? teamKind(rec) : "person";
    const linksRow = renderDetailLinks(rec.links || {});

    if (isTeam) {
      const teamPeople = people.filter(p => p.team === rec.record_id);
      const memberClusters = (cohort.clusters || []).filter(cl =>
        Array.isArray(cl.teams) && cl.teams.includes(rec.record_id)
      );
      detailHost.innerHTML = `
        <header class="cd-bar">
          <a class="cd-back" href="#" aria-label="back to grid"><span aria-hidden="true">←</span> back</a>
          <div class="cd-tag">
            <span>${escHtml(rec.record_id.toUpperCase())}</span>
            <span class="cd-sep">·</span>
            <span class="cd-kind cd-kind-${escHtml(shapeKind)}">${escHtml(shapeKind)}</span>
          </div>
          <a class="cd-edit" href="${escAttr(editUrl)}" target="_blank" rel="noopener noreferrer">edit on github →</a>
        </header>
        <section class="cd-hero">
          <div class="cd-shape"><canvas data-shape-fam="${shapeFam}" data-shape-kind="${escAttr(shapeKind)}" data-shape-seed="${escAttr(rec.record_id)}"></canvas></div>
          <div class="cd-hero-text">
            <h2 class="cd-name">${escHtml(rec.name || rec.record_id)}</h2>
            ${rec.focus ? `<p class="cd-focus">${escHtml(rec.focus)}</p>` : ""}
            <div class="cd-meta">
              ${rec.domain ? `<span><span class="cd-k">domain</span> ${escHtml(rec.domain)}</span><span class="cd-sep">·</span>` : ""}
              ${rec.geo ? `<span><span class="cd-k">geo</span> ${escHtml(rec.geo)}</span><span class="cd-sep">·</span>` : ""}
              <span><span class="cd-k">${shapeKind === "project" ? "contributors" : "team"}</span> ${teamPeople.length} ${teamPeople.length === 1 ? "person" : "people"}</span>
            </div>
          </div>
        </section>
        <div class="cd-grid">
          ${linksRow ? `<section class="cd-section"><h3 class="cd-h">links</h3>${linksRow}</section>` : ""}
          ${teamPeople.length ? `
            <section class="cd-section">
              <h3 class="cd-h">${shapeKind === "project" ? "contributors" : "members"} <span class="cd-h-aux">— ${teamPeople.length}</span></h3>
              <ul class="cd-people"></ul>
            </section>
          ` : ""}
          ${memberClusters.length ? `
            <section class="cd-section">
              <h3 class="cd-h">synergy clusters</h3>
              <div class="cd-clusters">${memberClusters.map(cl => `<span class="cd-cluster">${escHtml(cl.label)}</span>`).join("")}</div>
            </section>
          ` : ""}
        </div>
      `;
      // Mount member sub-cards using the same renderCohortCard primitive so
      // they look identical to the grid cards. Clicking a member jumps to
      // their own detail via the same hash routing.
      const peopleHost = detailHost.querySelector(".cd-people");
      if (peopleHost) {
        for (const p of teamPeople) {
          try {
            const card = renderCohortCard(p, {
              onClick: () => { location.hash = `#${encodeURIComponent(p.record_id)}`; },
            });
            if (card instanceof Node) {
              const li = document.createElement("li");
              li.appendChild(card);
              peopleHost.appendChild(li);
            }
          } catch (e) { console.warn("[cohort] member card render failed:", p.record_id, e); }
        }
      }
    } else {
      // Person detail.
      const team = rec.team ? teams.find(t => t.record_id === rec.team) : null;
      const datesLine = (rec.dates_start || rec.dates_end)
        ? `${escHtml(rec.dates_start || "—")} → ${escHtml(rec.dates_end || "—")}`
        : "—";
      detailHost.innerHTML = `
        <header class="cd-bar">
          <a class="cd-back" href="#" aria-label="back to grid"><span aria-hidden="true">←</span> back</a>
          <div class="cd-tag">
            <span>${escHtml(rec.record_id.toUpperCase())}</span>
            <span class="cd-sep">·</span>
            <span class="cd-kind cd-kind-person">${escHtml(rec.role_class || "person")}</span>
          </div>
          <a class="cd-edit" href="${escAttr(editUrl)}" target="_blank" rel="noopener noreferrer">edit on github →</a>
        </header>
        <section class="cd-hero">
          <div class="cd-shape"><canvas data-shape-fam="${shapeFam}" data-shape-kind="person" data-shape-seed="${escAttr(rec.record_id)}"></canvas></div>
          <div class="cd-hero-text">
            <h2 class="cd-name">${escHtml(rec.name || rec.record_id)}</h2>
            ${rec.role ? `<p class="cd-focus">${escHtml(rec.role)}</p>` : ""}
            <div class="cd-meta">
              ${team ? `<span><span class="cd-k">team</span> <a class="cd-team-link" href="#${encodeURIComponent(team.record_id)}">${escHtml(team.name || team.record_id)}</a></span><span class="cd-sep">·</span>` : ""}
              ${rec.geo ? `<span><span class="cd-k">geo</span> ${escHtml(rec.geo)}</span><span class="cd-sep">·</span>` : ""}
              <span><span class="cd-k">dates</span> ${datesLine}</span>
            </div>
          </div>
        </section>
        <div class="cd-grid">
          ${rec.bio ? `<section class="cd-section"><h3 class="cd-h">about</h3><p class="cd-bio">${escHtml(rec.bio)}</p></section>` : ""}
          ${linksRow ? `<section class="cd-section"><h3 class="cd-h">links</h3>${linksRow}</section>` : ""}
        </div>
      `;
    }

    // Wire back link — clearing the hash returns to grid.
    detailHost.querySelector(".cd-back")?.addEventListener("click", (e) => {
      e.preventDefault();
      location.hash = "";
    });

    requestAnimationFrame(() => {
      try { mountShapesIn(mount); }
      catch (e) { console.warn("[cohort] detail shape mount failed:", e); }
    });
  }

  function syncFromHash() {
    const id = parseDetailHash();
    const rec = id ? findRecord(id) : null;
    state.detail = rec ? rec.record_id : null;
    if (rec) {
      // Showing detail: hide the filter chips + grid, show the detail host.
      filterRows.forEach(el => el.hidden = true);
      grid.hidden = true;
      detailHost.hidden = false;
      renderDetail(rec);
      window.scrollTo({ top: 0, behavior: "auto" });
    } else {
      // Showing grid: hide detail, show chips + grid.
      detailHost.hidden = true;
      detailHost.innerHTML = "";
      filterRows.forEach(el => el.hidden = false);
      grid.hidden = false;
      renderGrid();
    }
  }

  for (const btn of mount.querySelectorAll(".cohort-chip[data-kind]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === state.kind) return;
      state.kind = btn.dataset.kind;
      state.membership = activeChipSet()[0].id;
      for (const b of mount.querySelectorAll(".cohort-chip[data-kind]")) {
        b.setAttribute("aria-selected", String(b.dataset.kind === state.kind));
      }
      renderGrid();
    });
  }

  // Counts strip — kept for parity with the previous version.
  const countsEl = document.getElementById("cohort-counts");
  if (countsEl) {
    const teamWord = teams.length === 1 ? "team" : "teams";
    const personWord = people.length === 1 ? "person" : "people";
    countsEl.textContent = `${teams.length} ${teamWord} · ${people.length} ${personWord}`;
    countsEl.hidden = false;
  }

  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();
})();
