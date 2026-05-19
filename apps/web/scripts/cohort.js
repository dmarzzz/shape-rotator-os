import { renderCohortCard, mountShapesIn } from "@shape-rotator/shape-ui";

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
};

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
  `;
  const membershipNav = mount.querySelector(".cohort-filter-membership");
  const grid = mount.querySelector("#cohort-grid");

  function activeChipSet() {
    return state.kind === "people" ? PERSON_CHIPS : TEAM_CHIPS;
  }

  function rerender() {
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
        rerender();
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
          const card = renderCohortCard(rec, { onClick: () => {} });
          if (card instanceof Node) grid.appendChild(card);
        } catch (e) { console.warn("[cohort] card render failed:", rec.record_id, e); }
      }
    }

    requestAnimationFrame(() => {
      try { mountShapesIn(mount); }
      catch (e) { console.warn("[cohort] shape mount failed:", e); }
    });
  }

  for (const btn of mount.querySelectorAll(".cohort-chip[data-kind]")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === state.kind) return;
      state.kind = btn.dataset.kind;
      state.membership = activeChipSet()[0].id;
      for (const b of mount.querySelectorAll(".cohort-chip[data-kind]")) {
        b.setAttribute("aria-selected", String(b.dataset.kind === state.kind));
      }
      rerender();
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

  rerender();
})();
