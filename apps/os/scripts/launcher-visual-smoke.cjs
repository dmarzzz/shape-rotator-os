const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_DIR = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(APP_DIR, "src", "index.html");
const CSS_PATH = path.join(APP_DIR, "src", "renderer", "cohort-chat.css");
const BOOT_PATH = path.join(APP_DIR, "src", "renderer", "boot.js");
const FIND_PATH = path.join(APP_DIR, "src", "renderer", "find.js");

app.disableHardwareAcceleration();

function fail(message, detail) {
  const error = new Error(message);
  error.detail = detail;
  throw error;
}

function launcherMarkup() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const start = html.indexOf('<div id="cohort-chat-dial-wrap"');
  const end = html.indexOf('<section id="atlas-view"', start);
  if (start < 0 || end < 0) throw new Error("launcher markup not found");
  return html.slice(start, end).trim();
}

function assertSourceGuards() {
  const boot = fs.readFileSync(BOOT_PATH, "utf8");
  const find = fs.readFileSync(FIND_PATH, "utf8");
  if (!boot.includes('m.openWithQuery?.(null, { scope: "global" })')) {
    fail("launcher search no longer forces global scope");
  }
  if (!boot.includes("openCohortTranscriptUpload")) {
    fail("launcher transcript upload no longer routes through the chat module");
  }
  if (!/setActionMenuOpen\(false\);\s*toggleCohortChatFromLauncher\(e\);/.test(boot)) {
    fail("orb click no longer collapses the action menu before chat opens");
  }
  if (!boot.includes('actionMenu.setAttribute("inert", "")') || !boot.includes('actionMenu.removeAttribute("inert")') || !boot.includes("window.setTimeout(applyInert, 180)")) {
    fail("launcher menu inert state is not toggled with visibility");
  }
  if (!find.includes("export function openWithQuery(query = null, opts = {})") || !find.includes("if (opts && opts.scope) setScope(opts.scope);")) {
    fail("find overlay no longer accepts an explicit launcher scope");
  }
}

function smokeHtml() {
  return `<!doctype html>
<html lang="en" data-ds="on">
  <head>
    <meta charset="utf-8" />
    <style>
      ${fs.readFileSync(CSS_PATH, "utf8")}

      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #101116;
        --ds-surface-1: #16181d;
        --ds-surface-2: #1d2027;
        --ds-surface-3: #272b34;
        --ds-border: #383d49;
        --ds-border-strong: #4a5160;
        --ds-accent: #eab308;
        --ds-accent-hover: #f6c63d;
        --ds-danger: #e8896b;
        --ds-ink-1: #ebeefa;
        --ds-ink-3: #aab0bf;
        --ds-ink-4: #757d90;
        --ds-focus: #8ab4ff;
        --ds-font-ui: Arial, sans-serif;
        --ds-font-mono: Consolas, monospace;
        --ds-text-xs: 12px;
      }
    </style>
  </head>
  <body>${launcherMarkup()}</body>
</html>`;
}

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "sros-launcher-smoke-")));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: false, nodeIntegration: false },
  });

  try {
    assertSourceGuards();
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(smokeHtml());
    await win.loadURL(url);
    const metrics = await win.webContents.executeJavaScript(`
      (async () => {
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
        };
        const wrap = document.getElementById("cohort-chat-dial-wrap");
        const menu = document.getElementById("cohort-chat-action-menu");
        const dial = document.getElementById("cohort-chat-dial");
        const actions = Array.from(document.querySelectorAll("[data-cohort-chat-action]"));
        let inertTimer = null;
        const setOpen = (open) => {
          if (inertTimer) {
            clearTimeout(inertTimer);
            inertTimer = null;
          }
          wrap.classList.toggle("is-expanded", open);
          menu.setAttribute("aria-hidden", open ? "false" : "true");
          if (open) menu.removeAttribute("inert");
          else {
            const applyInert = () => {
              if (!wrap.classList.contains("is-expanded")) menu.setAttribute("inert", "");
            };
            if (menu.hasAttribute("inert")) applyInert();
            else inertTimer = setTimeout(applyInert, 180);
          }
          dial.setAttribute("aria-expanded", open ? "true" : "false");
          actions.forEach((el) => { el.tabIndex = open ? 0 : -1; });
        };
        const finishTransitions = async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          for (const animation of menu.getAnimations()) {
            try { animation.finish(); } catch {}
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        };
        const initial = {
          ariaHidden: menu.getAttribute("aria-hidden"),
          inert: menu.hasAttribute("inert"),
          tabIndexes: actions.map((el) => el.tabIndex),
        };
        setOpen(true);
        await finishTransitions();
        const style = getComputedStyle(menu);
        const openStyle = { opacity: style.opacity, pointerEvents: style.pointerEvents, display: style.display };
        const openAttrs = {
          ariaHidden: menu.getAttribute("aria-hidden"),
          inert: menu.hasAttribute("inert"),
          expanded: dial.getAttribute("aria-expanded"),
          wrapClass: wrap.className,
          expandedMatch: menu.matches(".cohort-chat-dial-wrap.is-expanded .cohort-chat-action-menu"),
          tabIndexes: actions.map((el) => el.tabIndex),
        };
        const menuRect = rect(menu);
        const dialRect = rect(dial);
        setOpen(false);
        await finishTransitions();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const hiddenStyle = getComputedStyle(menu);
        const hiddenSnapshot = {
          opacity: hiddenStyle.opacity,
          pointerEvents: hiddenStyle.pointerEvents,
          ariaHidden: menu.getAttribute("aria-hidden"),
          inert: menu.hasAttribute("inert"),
          expanded: dial.getAttribute("aria-expanded"),
          wrapClass: wrap.className,
          expandedMatch: menu.matches(".cohort-chat-dial-wrap.is-expanded .cohort-chat-action-menu"),
          tabIndexes: actions.map((el) => el.tabIndex),
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          menu: menuRect,
          dial: dialRect,
          initial,
          openAttrs,
          openStyle,
          hiddenStyle: hiddenSnapshot,
          actions: actions.map((el) => ({ action: el.dataset.cohortChatAction, text: el.innerText.trim(), rect: rect(el) })),
        };
      })();
    `);

    const labels = metrics.actions.map((item) => item.action);
    const expected = ["chat", "search", "transcript", "sync"];
    if (JSON.stringify(labels) !== JSON.stringify(expected)) fail("unexpected action order", metrics);
    if (metrics.menu.x < 0 || metrics.menu.y < 0 || metrics.menu.right > metrics.viewport.width || metrics.menu.bottom > metrics.viewport.height) {
      fail("menu overflows viewport", metrics);
    }
    const separated =
      metrics.menu.right <= metrics.dial.x ||
      metrics.menu.x >= metrics.dial.right ||
      metrics.menu.bottom <= metrics.dial.y ||
      metrics.menu.y >= metrics.dial.bottom;
    if (!separated) fail("menu overlaps launcher orb", metrics);
    if (metrics.menu.width > 240 || metrics.menu.height > 280) fail("menu is too large", metrics);
    if (metrics.initial.ariaHidden !== "true" || !metrics.initial.inert || metrics.initial.tabIndexes.some((value) => value !== -1)) {
      fail("initial hidden menu is reachable", metrics);
    }
    if (metrics.openAttrs.ariaHidden !== "false" || metrics.openAttrs.inert || metrics.openAttrs.expanded !== "true" || metrics.openAttrs.tabIndexes.some((value) => value !== 0)) {
      fail("open menu accessibility state is incorrect", metrics);
    }
    if (metrics.openStyle.opacity !== "1" || metrics.openStyle.pointerEvents !== "auto") fail("open state is not interactive", metrics);
    if (metrics.hiddenStyle.opacity !== "0" || metrics.hiddenStyle.pointerEvents !== "none" || metrics.hiddenStyle.ariaHidden !== "true" || !metrics.hiddenStyle.inert || metrics.hiddenStyle.expanded !== "false" || metrics.hiddenStyle.tabIndexes.some((value) => value !== -1)) {
      fail("hidden state is not inert", metrics);
    }
    for (const item of metrics.actions) {
      if (!item.text || item.rect.height < 40) fail("action row is too small or unlabeled", metrics);
    }

    console.log(`[launcher-smoke] PASS: ${metrics.menu.width}x${metrics.menu.height}, ${labels.join(" / ")}`);
    app.exit(0);
  } catch (error) {
    console.error(`[launcher-smoke] FAIL: ${error && error.message ? error.message : String(error)}`);
    if (error && error.detail) console.error(JSON.stringify(error.detail, null, 2));
    app.exit(1);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
});
