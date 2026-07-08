const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.disableHardwareAcceleration();

const APP_DIR = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(APP_DIR, "src", "index.html");
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shape-os-membrane-context-"));
const WATCHDOG_MS = Number(process.env.SROS_MEMBRANE_CONTEXT_TIMEOUT_MS) || 60000;
const EVAL_TIMEOUT_MS = Number(process.env.SROS_MEMBRANE_CONTEXT_EVAL_TIMEOUT_MS) || 6000;

process.env.SWF_NODE_DISABLE = process.env.SWF_NODE_DISABLE || "1";
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

app.setPath("userData", USER_DATA_DIR);

function fail(message, detail) {
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
}

async function withTimeout(promise, ms, label) {
  return Promise.race([promise, timeout(ms, label)]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function js(src) {
  return `(() => { ${src} })()`;
}

async function evalIn(win, src, label = "renderer eval") {
  return withTimeout(win.webContents.executeJavaScript(src, true), EVAL_TIMEOUT_MS, label);
}

async function waitFor(win, predicateSrc, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await evalIn(win, `(() => { try { return !!(${predicateSrc}); } catch { return false; } })()`, label);
    if (ok) return;
    await sleep(120);
  }
  fail(`${label} timed out`);
}

async function settle(win, delay = 180) {
  try {
    await withTimeout(
      win.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true),
      1200,
      "settle"
    );
  } catch {}
  await sleep(delay);
}

async function clickCenter(win, selector, label) {
  const rect = await evalIn(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: Math.round(r.width), height: Math.round(r.height) };
  })()`, `${label} rect`);
  if (!rect || rect.width < 2 || rect.height < 2) fail(`${label} is not clickable`, rect);
  await evalIn(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el?.click();
    return !!el;
  })()`, `${label} click`);
  await settle(win, 220);
}

async function collect(win) {
  return evalIn(win, `(() => {
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
    const trigger = document.querySelector(".membrane-context-trigger");
    const triggerRect = rect(trigger);
    const triggerCenter = triggerRect
      ? { x: triggerRect.x + Math.round(triggerRect.width / 2), y: triggerRect.y + Math.round(triggerRect.height / 2) }
      : null;
    const topAtTrigger = triggerCenter
      ? document.elementsFromPoint(triggerCenter.x, triggerCenter.y).slice(0, 8).map((el) => ({
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ""),
          isTrigger: !!el.closest?.(".membrane-context-trigger"),
          isPrimaryNav: !!el.closest?.("#primary-nav"),
        }))
      : [];
    const card = document.querySelector(".membrane-context-card");
    const detail = document.querySelector(".mctx-detail");
    const cardText = card?.textContent?.replace(/\\s+/g, " ").trim() || "";
    const nav = document.getElementById("primary-nav");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      activeTab: document.body.dataset.activeTab || "",
      mode: document.getElementById("alchemy-view")?.dataset.alchModeCurrent || "",
      open: !!document.querySelector(".membrane-context-open"),
      expanded: !!document.querySelector(".membrane-context-expanded"),
      overlayHidden: document.querySelector(".membrane-context-overlay")?.hasAttribute("hidden") ?? true,
      triggerRect,
      topAtTrigger,
      navRect: rect(nav),
      navTransform: nav ? getComputedStyle(nav).transform : "",
      navPointerEvents: nav ? getComputedStyle(nav).pointerEvents : "",
      cardRect: rect(card),
      detailVisible: visible(detail),
      activeTabLabel: document.querySelector(".mctx-tab.is-active")?.textContent?.trim() || "",
      hiddenFullButtons: document.querySelectorAll("[data-context-full]").length,
      forbiddenText: /Open .*reader|Open topic library|full reader/i.test(cardText),
      readerBodies: document.querySelectorAll(".mctx-reader-body").length,
      miniLists: document.querySelectorAll(".mctx-mini-list").length,
      rows: document.querySelectorAll(".mctx-row").length,
      overflowX: card ? card.scrollWidth > Math.ceil(card.clientWidth) : false,
      detailText: detail?.textContent?.replace(/\\s+/g, " ").trim().slice(0, 380) || "",
    };
  })()`, "collect membrane context");
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => fail(`watchdog timed out after ${WATCHDOG_MS}ms`), WATCHDOG_MS);
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false },
  });

  try {
    await withTimeout(win.loadFile(INDEX_PATH), 18000, "load app");
    await waitFor(win, "window.__srwkAlchemyJump && document.getElementById('alchemy-view')", "app shell ready", 15000);
    await evalIn(win, js(`
      try { window.__srfgLaunch?.skip?.(); window.__srfgLaunch = null; } catch {}
      document.querySelector(".identity-modal-backdrop")?.remove();
      try {
        localStorage.setItem("srwk:identity_onboarding_skipped_v1", "1");
        localStorage.setItem("srwk:nav_discovered_v1", "0");
      } catch {}
      window.__srwkGoTab?.("alchemy");
      window.__srwkAlchemyJump?.("membrane");
      const nav = document.getElementById("primary-nav");
      if (nav) {
        nav.classList.add("is-nav-intent-open");
        nav.dataset.navIntent = "membrane-context-smoke";
        document.body.dataset.navDrawer = "open";
      }
      return true;
    `), "route membrane");
    await waitFor(win, "document.getElementById('alchemy-view')?.dataset.alchModeCurrent === 'membrane' && document.querySelector('.membrane-context-trigger')", "membrane ready", 12000);
    await settle(win, 400);

    const before = await collect(win);
    if (before.activeTab !== "alchemy" || before.mode !== "membrane") fail("membrane route did not load", before);
    if (!before.triggerRect || !before.navRect || before.triggerRect.x <= before.navRect.right + 8) {
      fail("context trigger is still inside the primary nav layer", before);
    }
    const triggerHitIndex = before.topAtTrigger.findIndex((item) => item.isTrigger);
    if (before.topAtTrigger[0]?.isPrimaryNav || triggerHitIndex < 0 || triggerHitIndex > 1) {
      fail("context trigger is covered by another layer", before);
    }

    await clickCenter(win, ".membrane-context-trigger", "context trigger");
    await waitFor(win, "document.querySelector('.membrane-context-open') && !document.querySelector('.membrane-context-overlay')?.hasAttribute('hidden')", "context overlay open", 8000);
    const opened = await collect(win);
    if (opened.navRect && opened.navRect.right > 4) fail("primary nav still covers the membrane context overlay", opened);
    if (opened.navPointerEvents !== "none") fail("primary nav still accepts pointer events while context is open", opened);

    await clickCenter(win, "[data-context-expand]", "context expand");
    await waitFor(win, "document.querySelector('.membrane-context-expanded')", "context expanded", 8000);
    const expanded = await collect(win);
    if (!expanded.detailVisible || !expanded.cardRect || expanded.cardRect.width < 900) fail("expanded context workspace did not take over enough of the screen", expanded);
    if (expanded.hiddenFullButtons || expanded.forbiddenText) fail("expanded context still exposes the old full-reader escape hatch", expanded);
    if (expanded.overflowX) fail("expanded context has horizontal overflow", expanded);

    await evalIn(win, "document.querySelector('[data-context-tab=\"sessions\"]')?.click()", "open sessions tab");
    await settle(win, 250);
    const sessions = await collect(win);
    if (sessions.activeTabLabel !== "sessions") fail("sessions tab did not activate", sessions);
    if (sessions.rows > 0 && !sessions.readerBodies) fail("sessions tab does not include an in-membrane readable body", sessions);
    if (sessions.hiddenFullButtons || sessions.forbiddenText || sessions.overflowX) fail("sessions tab is not self-contained", sessions);

    await evalIn(win, "document.querySelector('[data-context-tab=\"library\"]')?.click()", "open library tab");
    await settle(win, 250);
    const library = await collect(win);
    if (library.activeTabLabel !== "library") fail("library tab did not activate", library);
    if (library.rows > 0 && !library.miniLists) fail("library tab does not include in-membrane library detail lists", library);
    if (library.hiddenFullButtons || library.forbiddenText || library.overflowX) fail("library tab is not self-contained", library);

    await clickCenter(win, "[data-context-close]", "context close");
    await waitFor(win, "!document.querySelector('.membrane-context-open')", "context overlay closed", 8000);

    win.setSize(390, 760);
    await settle(win, 420);
    const mobileBefore = await collect(win);
    const mobileHitIndex = mobileBefore.topAtTrigger.findIndex((item) => item.isTrigger);
    if (!mobileBefore.triggerRect || mobileBefore.triggerRect.right > mobileBefore.viewport.width - 8) fail("mobile trigger is clipped", mobileBefore);
    if (mobileBefore.topAtTrigger[0]?.isPrimaryNav || mobileHitIndex < 0 || mobileHitIndex > 1) {
      fail("mobile context trigger is covered by another layer", mobileBefore);
    }
    await clickCenter(win, ".membrane-context-trigger", "mobile context trigger");
    await waitFor(win, "document.querySelector('.membrane-context-open') && !document.querySelector('.membrane-context-overlay')?.hasAttribute('hidden')", "mobile context overlay open", 8000);
    await clickCenter(win, "[data-context-expand]", "mobile context expand");
    await waitFor(win, "document.querySelector('.membrane-context-expanded')", "mobile context expanded", 8000);
    const mobileExpanded = await collect(win);
    if (!mobileExpanded.detailVisible || !mobileExpanded.cardRect || mobileExpanded.cardRect.width < 320) fail("mobile expanded context is not readable", mobileExpanded);
    if (mobileExpanded.hiddenFullButtons || mobileExpanded.forbiddenText || mobileExpanded.overflowX) fail("mobile context is not self-contained", mobileExpanded);
    await clickCenter(win, "[data-context-close]", "mobile context close");
    await waitFor(win, "!document.querySelector('.membrane-context-open')", "mobile context overlay closed", 8000);

    clearTimeout(watchdog);
    console.log(`[membrane-context-smoke] PASS: ${expanded.cardRect.width}x${expanded.cardRect.height}, sessions=${sessions.readerBodies}, library=${library.miniLists}`);
    app.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    console.error(`[membrane-context-smoke] FAIL: ${error && error.message ? error.message : String(error)}`);
    if (error && error.detail) console.error(JSON.stringify(error.detail, null, 2));
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});
