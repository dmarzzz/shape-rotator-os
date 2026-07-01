import { createLazyModule } from "./lazy-module.js";
import { loadStylesheetOnce } from "./stylesheet-loader.js";

const alchemyLazy = createLazyModule(() => import("./alchemy.js"));
const atlasLazy = createLazyModule(() => import("./atlas.js"));
const easelLazy = createLazyModule(() => import("./easel.js"));
const chatLazy = createLazyModule(() => import("./chat/chat.js"));
let chatStylesheetPromise = null;

function loadChatStylesheet() {
  if (!chatStylesheetPromise) {
    chatStylesheetPromise = loadStylesheetOnce("renderer/chat/chat.css");
  }
  return chatStylesheetPromise;
}

export function loadAlchemyModule() {
  return alchemyLazy.load();
}

export function loadAtlasModule() {
  return atlasLazy.load();
}

export function loadEaselModule() {
  return easelLazy.load();
}

export async function mountChatLazy(host) {
  const [module] = await Promise.all([chatLazy.load(), loadChatStylesheet()]);
  return module.mountChat(host);
}

function alchemyLocationFallback() {
  const view = document.getElementById("alchemy-view");
  return {
    mode: view?.dataset.alchModeCurrent || null,
    constellationMode: view?.dataset.constModeCurrent || null,
    contextView: view?.dataset.contextView || null,
    programPage: view?.dataset.alchProgramPage || null,
    recordId: view?.dataset.alchDetail || null,
  };
}

export const Alchemy = {
  closeMembraneMenu() { alchemyLazy.peek()?.closeMembraneMenu?.(); },
  toggleMembraneMenuFromTopTab() {
    return alchemyLazy.peek()?.toggleMembraneMenuFromTopTab?.() || false;
  },
  getLocation() {
    return alchemyLazy.peek()?.getLocation?.() || alchemyLocationFallback();
  },
  getRecordTitle(recordId) {
    return alchemyLazy.peek()?.getRecordTitle?.(recordId) || null;
  },
  applyLocation(loc) {
    return loadAlchemyModule()
      .then((module) => module.applyLocation?.(loc))
      .catch((e) => { console.error("[alchemy] applyLocation failed:", e); });
  },
  mount(stage) {
    return loadAlchemyModule().then((module) => {
      module.mount(stage);
      return module;
    });
  },
  setActive(active) { alchemyLazy.peek()?.setActive?.(active); },
  notifyDataChanged() { alchemyLazy.peek()?.notifyDataChanged?.(); },
};

export const Atlas = {
  notifyDataChanged() { atlasLazy.peek()?.notifyDataChanged?.(); },
  pulseNode(nodeId) { atlasLazy.peek()?.pulseNode?.(nodeId); },
  setActive(active) { atlasLazy.peek()?.setActive?.(active); },
};

export const Easel = {
  setActive(active) { easelLazy.peek()?.setActive?.(active); },
};

function scheduleIdleWork(label, fn, timeoutMs = 1500) {
  const run = () => {
    if (document.hidden) return;
    try { fn(); } catch (e) { console.warn(`[${label}] idle work failed:`, e?.message || e); }
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: timeoutMs });
  } else {
    setTimeout(run, timeoutMs);
  }
}

function afterFirstPaint(fn) {
  const raf = (cb) => {
    try { requestAnimationFrame(cb); } catch { setTimeout(cb, 80); }
  };
  raf(() => raf(fn));
}

function warmLazyModule(label, lazy) {
  lazy.load().catch((e) => {
    console.warn(`[${label}] warmup failed:`, e?.message || e);
  });
}

export function warmAlchemyModule() {
  warmLazyModule("alchemy", alchemyLazy);
}

function warmAlchemyMode(mode) {
  if (!mode) return;
  loadAlchemyModule()
    .then((module) => module.warmMode?.(mode))
    .catch((e) => {
      console.warn(`[alchemy:${mode}] warmup failed:`, e?.message || e);
    });
}

function warmCurrentAlchemySurface() {
  const loc = alchemyLazy.peek()?.getLocation?.() || alchemyLocationFallback();
  warmAlchemyMode(loc.mode || "membrane");
}

function warmAlchemyFirstRing() {
  const loc = alchemyLazy.peek()?.getLocation?.() || alchemyLocationFallback();
  const current = loc.mode || "membrane";
  const modes = [current, "membrane", "calendar", "context"];
  const seen = new Set();
  let delay = 0;
  for (const mode of modes) {
    if (!mode || seen.has(mode)) continue;
    seen.add(mode);
    setTimeout(() => warmAlchemyMode(mode), delay);
    delay += 450;
  }
}

export function warmChatModule() {
  loadChatStylesheet();
  warmLazyModule("matrix", chatLazy);
}

export function warmAppModule(key) {
  if (key === "atlas") warmLazyModule("atlas", atlasLazy);
  else if (key === "easel") warmLazyModule("easel", easelLazy);
}

export function warmTabModule(tab) {
  if (tab === "alchemy") warmAlchemyModule();
  else if (tab === "matrix") warmChatModule();
  else if (tab === "apps") warmAppModule(document.body.dataset.appsView || "atlas");
}

function warmFromIntentTarget(target) {
  const el = target?.closest?.("[data-app-key],[data-tab],[data-alch-mode]");
  if (!el) return;
  if (el.dataset.alchMode) warmAlchemyMode(el.dataset.alchMode);
  else if (el.dataset.appKey) warmAppModule(el.dataset.appKey);
  else if (el.dataset.tab) warmTabModule(el.dataset.tab);
}

export function wireRendererWarmupHints() {
  document.addEventListener("pointerover", (e) => warmFromIntentTarget(e.target), { passive: true });
  document.addEventListener("pointerdown", (e) => warmFromIntentTarget(e.target), { passive: true });
  document.addEventListener("focusin", (e) => warmFromIntentTarget(e.target));
}

export function schedulePostBootWarmups() {
  // Keep boot memory flat. Pointer/focus hints above still warm the module the
  // user is aiming at, but we no longer import every heavyweight surface after
  // first paint.
}
