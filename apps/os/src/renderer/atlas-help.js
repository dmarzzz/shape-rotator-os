import { loadStylesheetOnce } from "./stylesheet-loader.js";

let initialized = false;

export function warmAtlasHelp() {
  return loadStylesheetOnce("renderer/atlas-help.css");
}

export function initAtlasHelp() {
  warmAtlasHelp();
  if (initialized) return;

  const btn = document.getElementById("atlas-help-toggle");
  const panel = document.getElementById("atlas-help-panel");
  if (!btn || !panel) return;
  initialized = true;

  const closeBtn = panel.querySelector(".ahp-close");

  function close() {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }

  function open() {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
  }

  function toggle() {
    if (panel.hidden) open();
    else close();
  }

  function onOutside(e) {
    if (panel.hidden) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    close();
  }

  function onKey(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });
  if (closeBtn) closeBtn.addEventListener("click", close);

  const observer = new MutationObserver(() => {
    const inAtlas = document.body.dataset.activeTab === "apps"
      && document.body.dataset.appsView === "atlas";
    if (!inAtlas && !panel.hidden) close();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-active-tab", "data-apps-view"],
  });
}
