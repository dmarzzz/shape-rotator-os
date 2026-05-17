import { renderAvailabilityMatrix } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort?.people?.length) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  // Wrap in a scroll container — availability.css sticks the day-label
  // header to top:0, which only sticks within a scrollable ancestor.
  // This wrapper supplies that scroll context + a soft height cap so
  // large cohorts can scroll without exploding the page height.
  const wrap = document.createElement("div");
  wrap.className = "availability-wrap";
  mount.appendChild(wrap);
  try { renderAvailabilityMatrix({ people: cohort.people, container: wrap }); }
  catch (e) { mount.innerHTML = `<p class="page-empty">availability render failed: ${e.message}</p>`; }
})();
