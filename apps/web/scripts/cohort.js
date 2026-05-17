import { renderCohortCard, mountShapesIn } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  const grid = document.createElement("div");
  grid.className = "cohort-grid";
  const teams = cohort.teams || [];
  const people = cohort.people || [];
  const records = [...teams, ...people];
  for (const rec of records) {
    try {
      const card = renderCohortCard(rec, { onClick: () => {} });
      if (card instanceof Node) grid.appendChild(card);
    } catch (e) { console.warn("[cohort] card render failed:", rec.record_id, e); }
  }
  mount.appendChild(grid);

  // Counts strip: visible mono caps under the title (matches .page-meta).
  const counts = document.getElementById("cohort-counts");
  if (counts) {
    const teamWord = teams.length === 1 ? "team" : "teams";
    const personWord = people.length === 1 ? "person" : "people";
    counts.textContent = `${teams.length} ${teamWord} · ${people.length} ${personWord}`;
    counts.hidden = false;
  }

  // Wait a frame so layout settles — mountShapesIn paints each shape
  // by reading the placeholder canvas's getBoundingClientRect, which
  // returns zero until the grid has been laid out.
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try { mountShapesIn(mount); }
  catch (e) { console.warn("[cohort] shape mount failed:", e); }
})();
