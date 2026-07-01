const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const APP_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(
  process.env.SROS_NAV_AUDIT_OUT
    || path.join(os.tmpdir(), `shape-os-nav-audit-${Date.now()}`)
);
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shape-os-nav-audit-user-"));

process.env.SWF_NODE_DISABLE = process.env.SWF_NODE_DISABLE || "1";
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
process.env.SROS_NAV_AUDIT = "1";

fs.mkdirSync(OUT_DIR, { recursive: true });
app.setPath("userData", USER_DATA_DIR);

const logs = [];
const failures = [];
const shots = [];
const interactionChecks = [];
const TRACE_PATH = path.join(OUT_DIR, "audit-trace.log");
const WATCHDOG_MS = Number(process.env.SROS_NAV_AUDIT_TIMEOUT_MS) || 90000;
let watchdog = null;

function trace(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { fs.appendFileSync(TRACE_PATH, line); } catch {}
  process.stdout.write(`[nav-audit] ${message}\n`);
}

function finishAudit(code) {
  if (watchdog) clearTimeout(watchdog);
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
  } catch {}
  try { app.exit(code); } catch {}
  setTimeout(() => process.exit(code), 25);
}

watchdog = setTimeout(() => {
  const message = `audit watchdog timed out after ${WATCHDOG_MS}ms`;
  try { fs.writeFileSync(path.join(OUT_DIR, "audit-error.txt"), message); } catch {}
  trace(message);
  finishAudit(2);
}, WATCHDOG_MS);

function fail(message, detail) {
  failures.push({ message, detail });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeout(ms, label)]);
}

function js(src) {
  return `(() => { ${src} })()`;
}

async function evalIn(win, src, label = "renderer eval") {
  try {
    return await win.webContents.executeJavaScript(src, true);
  } catch (error) {
    fail(`${label} failed`, error && error.message ? error.message : String(error));
    return null;
  }
}

async function waitFor(win, predicateSrc, label, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await evalIn(win, `(() => { try { return !!(${predicateSrc}); } catch { return false; } })()`, label);
    if (ok) return true;
    await sleep(120);
  }
  fail(`${label} timed out`);
  return false;
}

async function settle(win, delay = 180) {
  await evalIn(win, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, "settle raf");
  await sleep(delay);
}

async function setDrawer(win, state) {
  if (state === "open") {
    await evalIn(win, js(`
      const nav = document.getElementById("primary-nav");
      if (nav) {
        nav.setAttribute("tabindex", "-1");
        nav.focus({ preventScroll: true });
      }
      return !!nav;
    `), "open drawer");
  } else {
    await evalIn(win, js(`
      const nav = document.getElementById("primary-nav");
      if (nav && nav.contains(document.activeElement)) document.activeElement.blur();
      if (document.activeElement === nav) nav.blur();
      let sink = document.getElementById("nav-audit-focus-sink");
      if (!sink) {
        sink = document.createElement("button");
        sink.id = "nav-audit-focus-sink";
        sink.type = "button";
        sink.tabIndex = -1;
        sink.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;outline:0;pointer-events:none;";
        document.body.appendChild(sink);
      }
      sink.focus({ preventScroll: true });
      return true;
    `), "close drawer");
    win.webContents.sendInputEvent({ type: "mouseMove", x: 1200, y: 860, movementX: 1200, movementY: 860 });
    await sleep(40);
    win.webContents.sendInputEvent({ type: "mouseMove", x: 860, y: 420, movementX: -340, movementY: -440 });
  }
  await settle(win, state === "open" ? 320 : 220);
}

function routeScript(route) {
  const opts = route.opts ? JSON.stringify(route.opts) : "{}";
  if (route.kind === "alchemy") {
    return js(`
      try { window.__srfgLaunch?.skip?.(); window.__srfgLaunch = null; } catch {}
      document.querySelector(".identity-modal-backdrop")?.remove();
      try { localStorage.setItem("srwk:identity_onboarding_skipped_v1", "1"); } catch {}
      window.__srwkGoTab?.("alchemy");
      window.__srwkAlchemyJump?.(${JSON.stringify(route.mode)}, ${opts});
      return true;
    `);
  }
  if (route.kind === "top") {
    return js(`
      try { window.__srfgLaunch?.skip?.(); window.__srfgLaunch = null; } catch {}
      document.querySelector(".identity-modal-backdrop")?.remove();
      try { localStorage.setItem("srwk:identity_onboarding_skipped_v1", "1"); } catch {}
      if (${JSON.stringify(route.tab)} === "apps") {
        delete document.body.dataset.appsView;
        try { localStorage.removeItem("srwk:apps_view"); } catch {}
      }
      window.__srwkGoTab?.(${JSON.stringify(route.tab)});
      return true;
    `);
  }
  if (route.kind === "app") {
    return js(`
      try { window.__srfgLaunch?.skip?.(); window.__srfgLaunch = null; } catch {}
      document.querySelector(".identity-modal-backdrop")?.remove();
      try { localStorage.setItem("srwk:identity_onboarding_skipped_v1", "1"); } catch {}
      window.__srwkOpenApp?.(${JSON.stringify(route.app)});
      return true;
    `);
  }
  if (route.kind === "network-card") {
    return `new Promise((resolve) => {
      try { window.__srfgLaunch?.skip?.(); window.__srfgLaunch = null; } catch {}
      document.querySelector(".identity-modal-backdrop")?.remove();
      try { localStorage.setItem("srwk:identity_onboarding_skipped_v1", "1"); } catch {}
      window.__srwkGoTab?.("apps");
      delete document.body.dataset.appsView;
      try { localStorage.removeItem("srwk:apps_view"); } catch {}
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelector('[data-app-key="network"]')?.click();
        resolve(true);
      }));
    })`;
  }
  return "true";
}

async function navigate(win, stage) {
  await evalIn(win, routeScript(stage.route), `navigate ${stage.name}`);
  await settle(win, stage.wait || 450);
  if (stage.route.kind === "alchemy") {
    await waitFor(
      win,
      `document.body.dataset.activeTab === "alchemy" && document.getElementById("alchemy-view")?.dataset.alchModeCurrent === ${JSON.stringify(stage.route.mode)}`,
      `route ${stage.name}`,
      8000
    );
  } else if (stage.expectTab) {
    await waitFor(win, `document.body.dataset.activeTab === ${JSON.stringify(stage.expectTab)}`, `route ${stage.name}`, 8000);
  }
}

function imageStats(nativeImage) {
  const size = nativeImage.getSize();
  const bitmap = typeof nativeImage.toBitmap === "function"
    ? nativeImage.toBitmap()
    : nativeImage.getBitmap();
  const step = Math.max(4, Math.floor((size.width * size.height) / 9000));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  const buckets = new Set();
  for (let p = 0; p < size.width * size.height; p += step) {
    const i = p * 4;
    const b = bitmap[i] || 0;
    const g = bitmap[i + 1] || 0;
    const r = bitmap[i + 2] || 0;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += l;
    sumSq += l * l;
    n += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4}`);
  }
  const mean = n ? sum / n : 0;
  const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
  return {
    width: size.width,
    height: size.height,
    mean: Number(mean.toFixed(2)),
    stdev: Number(Math.sqrt(variance).toFixed(2)),
    colorBuckets: buckets.size,
  };
}

async function collectDomState(win, stage) {
  const state = await evalIn(win, `(() => {
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity || 1) > 0.01 && r.width > 1 && r.height > 1;
    };
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const nav = document.getElementById("primary-nav");
    const firstNavChild = nav?.firstElementChild || null;
    const rootStyle = getComputedStyle(document.documentElement);
    const navHotWidth = Math.round(Number.parseFloat(rootStyle.getPropertyValue("--nav-hot-w")) || 0);
    const appLabels = [...document.querySelectorAll(".app-card-label")].map((el) => el.textContent.trim());
    const contextRows = [...document.querySelectorAll("#context-subnav .alch-rail-sub-btn")].map((el) => ({
      key: el.dataset.subView,
      label: el.textContent.replace(/[\\s\\u2500-\\u257F]+/g, " ").trim(),
      selected: el.getAttribute("aria-selected") === "true",
      visible: visible(el),
    }));
    const navRows = [...document.querySelectorAll("#primary-nav [data-tab], #primary-nav [data-alch-mode]")].map((el) => ({
      tab: el.dataset.tab || "",
      mode: el.dataset.alchMode || "",
      text: el.textContent.trim().replace(/\\s+/g, " "),
      selected: el.getAttribute("aria-selected") === "true",
      expanded: el.getAttribute("aria-expanded") || "",
      visible: visible(el),
    }));
    const visibleContent = [...document.querySelectorAll(
      "#alchemy-view, #chat-view, #apps-grid, #links-view, #network-view, #metrics-view, #atlas-view, #easel-view"
    )].filter(visible).map((el) => ({ id: el.id, rect: rect(el) }));
    const overflow = [...document.querySelectorAll("#primary-nav button, #content-top .os-tab-title, .apps-grid button, .links-view a")]
      .filter(visible)
      .map((el) => {
        const cs = getComputedStyle(el);
        return {
          text: el.textContent.trim().replace(/\\s+/g, " ").slice(0, 80),
          clip: el.scrollWidth - el.clientWidth,
          overflowX: cs.overflowX,
          rect: rect(el),
        };
      })
      .filter((item) => item.clip > 3 && item.overflowX === "visible")
      .slice(0, 12);
    const pageTitle = document.querySelector("#alchemy-canvas h1, #alchemy-canvas h2, .apps-grid-title, .links-title, .chat-title, .net-title, .metrics-title")?.textContent?.trim() || "";
    const contentTop = document.getElementById("content-top");
    return {
      stage: ${JSON.stringify(stage.name)},
      viewport: { width: innerWidth, height: innerHeight },
      activeTab: document.body.dataset.activeTab || "",
      appsView: document.body.dataset.appsView || "",
      netSub: document.body.dataset.netSub || "",
      alchemyMode: document.getElementById("alchemy-view")?.dataset.alchModeCurrent || "",
      contextView: document.getElementById("alchemy-view")?.dataset.contextView || "",
      pageTitle,
      nav: {
        rect: rect(nav),
        hotWidth: navHotWidth,
        hover: !!document.querySelector("#primary-nav:hover"),
        intentOpen: !!nav?.classList.contains("is-nav-intent-open"),
        intent: nav?.dataset.navIntent || "",
        motionMs: nav ? getComputedStyle(nav).getPropertyValue("--nav-motion-ms").trim() : "",
        transform: nav ? getComputedStyle(nav).transform : "",
        childOpacity: firstNavChild ? getComputedStyle(firstNavChild).opacity : "",
        hasNetworkNav: !!document.querySelector('#primary-nav [data-tab="network"], #primary-nav [data-alch-mode="network"]'),
        matrixAfterMembrane: (() => {
          const membrane = nav?.querySelector('[data-alch-mode="membrane"]');
          const matrix = nav?.querySelector('[data-tab="matrix"]');
          const cohort = nav?.querySelector('[data-alch-mode="shapes"]');
          if (!membrane || !matrix || !cohort) return false;
          return !!(membrane.compareDocumentPosition(matrix) & Node.DOCUMENT_POSITION_FOLLOWING)
            && !!(matrix.compareDocumentPosition(cohort) & Node.DOCUMENT_POSITION_FOLLOWING);
        })(),
        rows: navRows,
      },
      appLabels,
      contextRows,
      visibleContent,
      overflow,
      blockers: {
        launch: !!document.querySelector(".sig-launch"),
        identityModal: !!document.querySelector(".identity-modal-backdrop"),
        palette: !!document.querySelector(".cmd-palette:not([hidden]), .kbd-overlay:not([hidden])"),
      },
      bodyGrid: getComputedStyle(document.body).gridTemplateColumns,
      contentTop: rect(contentTop),
    };
  })()`, `collect ${stage.name}`);
  return state || {};
}

function assertStage(stage, dom, stats) {
  if (dom.blockers?.launch) fail(`${stage.name}: launch overlay is still visible`);
  if (dom.blockers?.identityModal) fail(`${stage.name}: identity modal is blocking the app`);
  if (!dom.visibleContent || !dom.visibleContent.length) fail(`${stage.name}: no top-level content surface is visible`, dom);
  if (stats.colorBuckets < 18 || stats.stdev < 4) fail(`${stage.name}: screenshot looks blank or under-rendered`, stats);
  if (dom.nav?.hasNetworkNav) fail(`${stage.name}: network still appears in the primary nav`);
  if (!dom.nav?.matrixAfterMembrane) fail(`${stage.name}: matrix is not directly beneath membrane`);
  if (!String(dom.bodyGrid || "").includes("1fr") && !String(dom.bodyGrid || "").includes("px")) {
    fail(`${stage.name}: body grid columns are not measurable`, dom.bodyGrid);
  }
  if (Array.isArray(dom.overflow) && dom.overflow.length) {
    fail(`${stage.name}: visible controls have uncontained text overflow`, dom.overflow);
  }
  if (stage.drawer === "closed") {
    const expected = Number(dom.nav?.hotWidth || 0);
    const min = Math.max(16, expected - 4);
    const max = Math.max(20, expected + 4);
    if (!dom.nav?.rect || dom.nav.rect.right < min || dom.nav.rect.right > max) fail(`${stage.name}: collapsed drawer rail is not in its affordance band`, dom.nav);
    if (Number(dom.nav?.childOpacity || 0) > 0.08) fail(`${stage.name}: hidden drawer labels are still visible`, dom.nav);
  }
  if (stage.drawer === "open") {
    if (!dom.nav?.rect || dom.nav.rect.right < 250) fail(`${stage.name}: hover drawer did not open`, dom.nav);
    if (Number(dom.nav?.childOpacity || 0) < 0.85) fail(`${stage.name}: open drawer labels are not visible`, dom.nav);
  }
  if (stage.expectTab && dom.activeTab !== stage.expectTab) {
    fail(`${stage.name}: wrong active top-level tab`, { expected: stage.expectTab, actual: dom.activeTab });
  }
  if (stage.expectAlchemyMode && dom.alchemyMode !== stage.expectAlchemyMode) {
    fail(`${stage.name}: wrong alchemy mode`, { expected: stage.expectAlchemyMode, actual: dom.alchemyMode });
  }
  if (stage.expectContextView && dom.contextView !== stage.expectContextView) {
    fail(`${stage.name}: wrong context subview`, { expected: stage.expectContextView, actual: dom.contextView });
  }
  if (stage.expectAppsView !== undefined && dom.appsView !== stage.expectAppsView) {
    fail(`${stage.name}: wrong apps subview`, { expected: stage.expectAppsView, actual: dom.appsView });
  }
  if (stage.name.includes("apps-grid")) {
    const labels = dom.appLabels || [];
    for (const label of ["atlas", "network", "easel", "router"]) {
      if (!labels.includes(label)) fail(`${stage.name}: missing app card`, { label, labels });
    }
  }
  if (stage.name.includes("context-activity")) {
    const selected = (dom.contextRows || []).find((row) => row.selected);
    if (!selected || selected.key !== "activity") fail(`${stage.name}: context activity child is not selected`, dom.contextRows);
  }
}

async function assertPointerIntentTempo(win) {
  await setDrawer(win, "closed");

  win.webContents.sendInputEvent({ type: "mouseMove", x: 920, y: 500, movementX: 920, movementY: 500 });
  await settle(win, 80);
  win.webContents.sendInputEvent({ type: "mouseMove", x: 6, y: 500, movementX: -914, movementY: 0 });
  await settle(win, 120);
  const fast = await evalIn(win, `(() => {
    const nav = document.getElementById("primary-nav");
    const r = nav?.getBoundingClientRect();
    return {
      navRight: r ? Math.round(r.right) : null,
      intent: nav?.dataset.navIntent || "",
      motionMs: nav ? getComputedStyle(nav).getPropertyValue("--nav-motion-ms").trim() : "",
    };
  })()`, "pointer fast intent state");
  interactionChecks.push({ name: "pointer-fast-open", state: fast });
  if (!fast || fast.navRight < 250) fail("pointer-fast-open: sudden edge hit did not open the drawer", fast);
  if (fast?.intent !== "edge-fast") fail("pointer-fast-open: sudden edge hit did not use the fast intent path", fast);

  await setDrawer(win, "closed");
  win.webContents.sendInputEvent({ type: "mouseMove", x: 72, y: 520, movementX: 66, movementY: 20 });
  await sleep(260);
  win.webContents.sendInputEvent({ type: "mouseMove", x: 36, y: 520, movementX: -36, movementY: 0 });
  await settle(win, 260);
  const slow = await evalIn(win, `(() => {
    const nav = document.getElementById("primary-nav");
    const r = nav?.getBoundingClientRect();
    return {
      navRight: r ? Math.round(r.right) : null,
      intent: nav?.dataset.navIntent || "",
      motionMs: nav ? getComputedStyle(nav).getPropertyValue("--nav-motion-ms").trim() : "",
    };
  })()`, "pointer slow intent state");
  interactionChecks.push({ name: "pointer-slow-open", state: slow });
  if (!slow || slow.navRight < 250) fail("pointer-slow-open: slow near-edge approach did not open the drawer", slow);
  if (slow?.intent !== "edge-slow") fail("pointer-slow-open: slow near-edge approach did not use the slower intent path", slow);
}

async function assertPointerDismissesDrawer(win) {
  await setDrawer(win, "closed");
  const target = await evalIn(win, `(() => {
    const nav = document.getElementById("primary-nav");
    const btn = nav?.querySelector('[data-tab="links"]');
    const rootStyle = getComputedStyle(document.documentElement);
    const hotWidth = Math.round(Number.parseFloat(rootStyle.getPropertyValue("--nav-hot-w")) || 0);
    if (!nav || !btn) return null;
    const r = btn.getBoundingClientRect();
    return {
      hotWidth,
      enterX: Math.max(4, Math.floor(hotWidth / 2)),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  })()`, "pointer dismiss target");
  if (!target) {
    fail("pointer-dismiss: links nav target was not measurable");
    return;
  }

  win.webContents.sendInputEvent({ type: "mouseMove", x: target.enterX, y: target.y, movementX: 0, movementY: 0 });
  await settle(win, 260);
  const clickTarget = await evalIn(win, `(() => {
    const btn = document.querySelector('#primary-nav [data-tab="links"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`, "pointer dismiss click target");
  if (!clickTarget) {
    fail("pointer-dismiss: links nav target did not open");
    return;
  }
  win.webContents.sendInputEvent({ type: "mouseMove", x: clickTarget.x, y: clickTarget.y, movementX: clickTarget.x - target.enterX, movementY: 0 });
  await settle(win, 80);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", x: clickTarget.x, y: clickTarget.y, clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", x: clickTarget.x, y: clickTarget.y, clickCount: 1 });
  await settle(win, 160);
  win.webContents.sendInputEvent({ type: "mouseMove", x: 860, y: 420, movementX: 860 - clickTarget.x, movementY: 420 - clickTarget.y });
  await settle(win, 360);

  const state = await evalIn(win, `(() => {
    const nav = document.getElementById("primary-nav");
    const rootStyle = getComputedStyle(document.documentElement);
    const hotWidth = Math.round(Number.parseFloat(rootStyle.getPropertyValue("--nav-hot-w")) || 0);
    const r = nav?.getBoundingClientRect();
    return {
      hotWidth,
      navRight: r ? Math.round(r.right) : null,
      activeInside: !!(nav && nav.contains(document.activeElement)),
      activeTab: document.body.dataset.activeTab || "",
    };
  })()`, "pointer dismiss state");
  interactionChecks.push({ name: "pointer-dismiss", state });
  const max = Math.max(20, Number(state?.hotWidth || 0) + 4);
  if (!state || state.navRight > max) fail("pointer-dismiss: drawer stayed open after pointer left", state);
  if (state?.activeInside) fail("pointer-dismiss: nav kept pointer focus after pointer left", state);
  if (state?.activeTab !== "links") fail("pointer-dismiss: click did not activate links", state);
}

const stages = [
  { name: "00-membrane-closed", route: { kind: "alchemy", mode: "membrane" }, drawer: "closed", expectTab: "alchemy", expectAlchemyMode: "membrane" },
  { name: "01-membrane-drawer-open", route: { kind: "alchemy", mode: "membrane" }, drawer: "open", expectTab: "alchemy", expectAlchemyMode: "membrane" },
  { name: "02-matrix-closed", route: { kind: "top", tab: "matrix" }, drawer: "closed", expectTab: "matrix", wait: 700 },
  { name: "03-cohort-drawer-open", route: { kind: "alchemy", mode: "shapes" }, drawer: "open", expectTab: "alchemy", expectAlchemyMode: "shapes" },
  { name: "04-calendar-closed", route: { kind: "alchemy", mode: "calendar", opts: { calendarView: "cal" } }, drawer: "closed", expectTab: "alchemy", expectAlchemyMode: "calendar", wait: 650 },
  { name: "05-mirror-closed", route: { kind: "alchemy", mode: "mirror" }, drawer: "closed", expectTab: "alchemy", expectAlchemyMode: "mirror" },
  { name: "06-program-drawer-open", route: { kind: "alchemy", mode: "program" }, drawer: "open", expectTab: "alchemy", expectAlchemyMode: "program" },
  { name: "07-context-articles-drawer-open", route: { kind: "alchemy", mode: "context", opts: { contextView: "articles" } }, drawer: "open", expectTab: "alchemy", expectAlchemyMode: "context", expectContextView: "articles" },
  { name: "08-context-activity-drawer-open", route: { kind: "alchemy", mode: "activity" }, drawer: "open", expectTab: "alchemy", expectAlchemyMode: "activity" },
  { name: "09-apps-grid-closed", route: { kind: "top", tab: "apps" }, drawer: "closed", expectTab: "apps", expectAppsView: "" },
  { name: "10-apps-grid-drawer-open", route: { kind: "top", tab: "apps" }, drawer: "open", expectTab: "apps", expectAppsView: "" },
  { name: "11-network-via-app-card-closed", route: { kind: "network-card" }, drawer: "closed", expectTab: "network" },
  { name: "12-links-closed", route: { kind: "top", tab: "links" }, drawer: "closed", expectTab: "links" },
  { name: "13-atlas-app-closed", route: { kind: "app", app: "atlas" }, drawer: "closed", expectTab: "apps", expectAppsView: "atlas", wait: 900 },
  { name: "14-easel-app-closed", route: { kind: "app", app: "easel" }, drawer: "closed", expectTab: "apps", expectAppsView: "easel", wait: 900 },
];

async function main() {
  const ready = new Promise((resolve) => ipcMain.once("smoke:ready", resolve));
  trace("requiring main.js");
  require(path.join(APP_DIR, "main.js"));
  trace("main.js required; waiting for renderer ready");
  await withTimeout(ready, 45000, "renderer ready");
  trace("renderer ready");

  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) throw new Error("no app window");
  trace("app window found");

  win.webContents.on("console-message", (_event, a, b) => {
    const msg = a && typeof a === "object" ? a.message : b;
    const level = a && typeof a === "object" ? a.level : a;
    if (level >= 2) logs.push(String(msg || ""));
  });

  win.setSize(1440, 940);
  win.center();
  win.show();
  win.focus();

  await waitFor(win, `typeof window.__srwkGoTab === "function" && typeof window.__srwkAlchemyJump === "function" && typeof window.__srwkOpenApp === "function"`, "navigation hooks", 20000);
  await evalIn(win, js(`
    document.documentElement.dataset.reduceMotion = "1";
    try { localStorage.setItem("srwk:identity_onboarding_skipped_v1", "1"); } catch {}
    try { window.__srfgLaunch?.skip?.(); window.__srfgLaunch = null; } catch {}
    document.querySelector(".identity-modal-backdrop")?.remove();
    return true;
  `), "audit setup");
  await waitFor(win, `!document.querySelector(".sig-launch")`, "launch overlay dismissed", 9000);

  for (const stage of stages) {
    trace(`stage ${stage.name}`);
    await navigate(win, stage);
    await setDrawer(win, stage.drawer);
    const image = await win.webContents.capturePage();
    const pngPath = path.join(OUT_DIR, `${stage.name}.png`);
    fs.writeFileSync(pngPath, image.toPNG());
    const stats = imageStats(image);
    const dom = await collectDomState(win, stage);
    assertStage(stage, dom, stats);
    shots.push({ name: stage.name, path: pngPath, stats, dom });
    process.stdout.write(`[nav-audit] ${stage.name} -> ${pngPath}\n`);
  }

  trace("interaction pointer-intent-tempo");
  await assertPointerIntentTempo(win);
  trace("interaction pointer-dismiss");
  await assertPointerDismissesDrawer(win);

  const report = {
    ok: failures.length === 0,
    outDir: OUT_DIR,
    userDataDir: USER_DATA_DIR,
    shots: shots.map((shot) => ({
      name: shot.name,
      path: shot.path,
      stats: shot.stats,
      activeTab: shot.dom.activeTab,
      alchemyMode: shot.dom.alchemyMode,
      contextView: shot.dom.contextView,
      appsView: shot.dom.appsView,
      nav: shot.dom.nav,
      visibleContent: shot.dom.visibleContent,
    })),
    failures,
    interactionChecks,
    consoleWarnings: logs,
  };
  const reportPath = path.join(OUT_DIR, "audit-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`[nav-audit] report -> ${reportPath}\n`);

  if (failures.length) {
    for (const item of failures) process.stderr.write(`[nav-audit] FAIL ${item.message}\n`);
    finishAudit(1);
    return;
  }
  process.stdout.write(`[nav-audit] PASS ${shots.length} screenshots\n`);
  finishAudit(0);
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  try {
    fs.writeFileSync(path.join(OUT_DIR, "audit-error.txt"), message);
  } catch {}
  process.stderr.write(`[nav-audit] ERROR ${message}\n`);
  finishAudit(1);
});
