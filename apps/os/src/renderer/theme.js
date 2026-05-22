// theme.js — light/dark palette switch for the alchemy surface.
//
// The OS app was dark-only up to issue #130. Profile lives on the alchemy
// surface, so the toggle is mounted in the profile-mode header (see
// renderProfile() in alchemy.js). We swap a `data-theme` attribute on
// <html> and the CSS in styles.css does the rest via
// `:root[data-theme="light"]` overrides for the --alchemy-* palette vars.
//
// The choice is persisted in localStorage so the next launch starts in
// the same mode. applyStoredTheme() is called at boot before any
// alchemy rendering to avoid a dark→light flash.

const LS_KEY = "srwk:theme";
const VALID = new Set(["dark", "light"]);
const listeners = new Set();

export function getTheme() {
  const t = document.documentElement.dataset.theme;
  return VALID.has(t) ? t : "dark";
}

export function setTheme(mode) {
  const next = VALID.has(mode) ? mode : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(LS_KEY, next); } catch {}
  for (const fn of listeners) {
    try { fn(next); } catch {}
  }
}

export function toggleTheme() {
  setTheme(getTheme() === "light" ? "dark" : "light");
  return getTheme();
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Apply the persisted theme on app boot. Safe to call multiple times.
export function applyStoredTheme() {
  let saved = "dark";
  try { saved = localStorage.getItem(LS_KEY) || "dark"; } catch {}
  document.documentElement.dataset.theme = VALID.has(saved) ? saved : "dark";
}
