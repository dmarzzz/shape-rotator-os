import { renderCohortCalendar } from "@shape-rotator/shape-ui";

(async function init() {
  const r = await fetch("/cohort-surface.json").catch(() => null);
  const cohort = r && r.ok ? await r.json() : null;
  const mount = document.getElementById("mount");
  if (!cohort) { mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>'; return; }
  // Wrap in a sized scroll container — cohort-calendar.js paints a
  // canvas whose intrinsic width = LEFT_W + numDays * DAY_W, which
  // will overflow a narrow viewport. The wrapper provides horizontal
  // scroll + the visual frame.
  const wrap = document.createElement("div");
  wrap.className = "calendar-wrap";
  mount.appendChild(wrap);
  try { renderCohortCalendar({ container: wrap, cohort }); }
  catch (e) { mount.innerHTML = `<p class="page-empty">calendar render failed: ${e.message}</p>`; }
})();
