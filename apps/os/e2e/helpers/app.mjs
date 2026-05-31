// app.mjs — page-object-ish helpers shared across specs. Keeps specs readable
// and centralizes the "how do I drive Shape Rotator OS" knowledge.
//
// IMPORTANT — driver quirk: tauri-plugin-webdriver-automation 0.1.x does NOT
// rehydrate WebElement references passed as arguments into `execute`. That
// breaks WebdriverIO's built-in visibility path (`isDisplayed`/`toBeDisplayed`/
// `waitForDisplayed`), which falls back to an injected script that calls
// `node.contains(el)` with the (un-rehydrated) element and throws
// "Argument 1 ('other') to Node.contains must be an instance of Node".
// So we NEVER use those matchers. Visibility is checked here via execute with a
// *selector string* (no element arg), which the driver handles fine.

import { $, browser, expect } from "@wdio/globals";
import { S } from "./selectors.mjs";

// Fully-live writes (real GitHub PRs) are OFF unless the operator opts in.
// See e2e/README.md. Read-only live behavior (peers, atlas, search) always runs.
export const WRITES_ALLOWED = process.env.SRWK_E2E_ALLOW_WRITES === "1";

// ─── visibility (selector-based; never passes elements into execute) ────────

/** True if the selector resolves to a laid-out, non-hidden element. */
export async function isVisible(selector) {
  return browser.execute((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    if (parseFloat(s.opacity || "1") === 0) return false;
    return el.getClientRects().length > 0;
  }, selector);
}

/** Wait until a selector exists and is visible. */
export async function waitVisible(selector, timeout = 20000, msg) {
  await $(selector).waitForExist({ timeout });
  await browser.waitUntil(() => isVisible(selector), {
    timeout,
    timeoutMsg: msg || `never became visible: ${selector}`,
  });
}

/** Wait until a selector is gone or not visible. */
export async function waitHidden(selector, timeout = 20000, msg) {
  await browser.waitUntil(async () => !(await isVisible(selector)), {
    timeout,
    timeoutMsg: msg || `never hid: ${selector}`,
  });
}

/** Assert visible now (throws with a clear message if not). */
export async function expectVisible(selector) {
  await waitVisible(selector);
  expect(await isVisible(selector)).toBe(true);
}

/** True if any of the given selectors is visible. */
export async function anyVisible(selectors) {
  for (const sel of selectors) {
    if (await isVisible(sel)) return true;
  }
  return false;
}

// ─── boot + state readers ───────────────────────────────────────────────────

/**
 * Wait until the app actually has a webview window and make it the active one.
 * tauri-wd announces the session as soon as the plugin server binds — which is
 * BEFORE the Tauri window is created — so right after session creation any
 * element command throws a fatal "no such window". We poll for a window handle
 * (the window appears a beat later) and switch to it before doing anything else.
 */
export async function waitForWindow(timeout = 90000) {
  // Poll GET /window (getWindowHandle, singular). tauri-wd implements this and
  // returns a "no such window" error until the webview exists, then the handle.
  // (getWindowHandles — plural — is NOT implemented by tauri-wd 0.1.x; it 404s,
  // so don't use it.)
  await browser.waitUntil(
    async () => {
      try {
        const h = await browser.getWindowHandle();
        return !!h;
      } catch {
        return false; // window not up yet
      }
    },
    { timeout, timeoutMsg: "app window never appeared" },
  );
}

/**
 * Wait until the renderer has booted: a window exists, the tab bar is present,
 * and the body has settled on an active tab (applyActiveTab runs during boot
 * and sets data-active-tab).
 */
export async function waitForBoot() {
  await waitForWindow();
  // Give injected scripts room; the renderer boots three.js + a force graph,
  // which can keep the main thread busy right after the window appears.
  try {
    await browser.setTimeout({ script: 60000, pageLoad: 120000 });
  } catch {
    /* some drivers reject setTimeout — non-fatal */
  }
  await waitForRenderer();
  await browser.waitUntil(
    async () => {
      const t = await getActiveTab();
      return typeof t === "string" && t.length > 0;
    },
    { timeout: 90000, timeoutMsg: "renderer never set body[data-active-tab]" },
  );
}

/**
 * Wait until the page document is loaded and the tab bar exists — checked via
 * `execute` (a simple DOM query), NOT findElement, and tolerant of transient
 * "script timed out" while the heavy renderer is still initializing.
 */
export async function waitForRenderer(timeout = 120000) {
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute(
          () =>
            document.readyState === "complete" &&
            !!document.getElementById("tab-bar"),
        );
      } catch {
        return false; // page busy / script timed out — keep polling
      }
    },
    { timeout, interval: 2000, timeoutMsg: "renderer never became ready" },
  );
}

export async function getActiveTab() {
  return browser.execute(() => document.body.dataset.activeTab || "");
}

export async function getNetSub() {
  return browser.execute(() => document.body.dataset.netSub || "");
}

export async function getAppsView() {
  return browser.execute(() => document.body.dataset.appsView || "");
}

// ─── navigation ──────────────────────────────────────────────────────────────

/** Click a top tab and wait for body[data-active-tab] to flip. Retries once to
 *  absorb a missed-first-click race against boot wiring / morph animation. */
export async function openTab(name) {
  const sel = S.tab(name);
  await $(sel).waitForExist({ timeout: 20000 });
  if ((await getActiveTab()) === name) return;
  await $(sel).click();
  try {
    await browser.waitUntil(async () => (await getActiveTab()) === name, {
      timeout: 8000,
    });
  } catch {
    // second attempt — boot may have wired the listener a tick after we clicked
    await $(sel).click();
    await browser.waitUntil(async () => (await getActiveTab()) === name, {
      timeout: 12000,
      timeoutMsg: `top tab never became "${name}"`,
    });
  }
  await expect($(sel)).toHaveAttribute("aria-selected", "true");
}

/** Switch the alchemy left-rail mode (membrane | cohort | profile | ...). */
export async function openAlchemyMode(mode) {
  await openTab("alchemy");
  const sel = S.alchRailBtn(mode);
  await $(sel).waitForExist({ timeout: 20000 });
  await $(sel).click();
  await browser.waitUntil(
    async () =>
      (await $(sel).getAttribute("aria-selected")) === "true",
    { timeout: 15000, timeoutMsg: `alchemy mode never selected: ${mode}` },
  );
}

/** Switch the network sub-tab (network | metrics). */
export async function openNetSub(sub) {
  await openTab("network");
  const sel = S.netSubtab(sub);
  await $(sel).waitForExist({ timeout: 20000 });
  await $(sel).click();
  await browser.waitUntil(async () => (await getNetSub()) === sub, {
    timeout: 15000,
    timeoutMsg: `network sub-tab never became "${sub}"`,
  });
}

/** Open an app card from the apps grid (atlas | easel). */
export async function openApp(key) {
  await openTab("apps");
  const sel = S.appCard(key);
  await $(sel).waitForExist({ timeout: 20000 });
  await $(sel).click();
  await browser.waitUntil(async () => (await getAppsView()) === key, {
    timeout: 15000,
    timeoutMsg: `apps view never became "${key}"`,
  });
}

/**
 * Open the apps tab and ensure the grid is showing. All app instances share one
 * user-data-dir, so localStorage (incl. the restored apps sub-view) persists
 * across sessions — a prior spec may have left atlas/easel open. Click back out
 * of any restored sub-app so we land on the grid deterministically.
 */
export async function gotoAppsGrid() {
  await openTab("apps");
  const view = await getAppsView();
  if (view === "atlas" || view === "easel") {
    await browser.execute((v) => {
      document.querySelector(`#${v}-view [data-apps-back]`)?.click();
    }, view);
  }
  await waitVisible(S.appsGrid);
}

/** True if a selector exists and has at least one child element. */
export async function hasChildren(selector) {
  return browser.execute((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.childElementCount > 0;
  }, selector);
}

/**
 * Dispatch a synthetic keydown on document. The app's global shortcuts listen
 * on document keydown; tauri-wd's `browser.keys()` (real OS key events) does
 * not reliably reach those handlers, but a dispatched KeyboardEvent does.
 */
export async function dispatchKey(key, opts = {}) {
  await browser.execute(
    (k, o) => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }),
      );
    },
    key,
    opts,
  );
}

/** Set an input's value via the DOM + fire input/change (reliable through the bridge). */
export async function setInputValue(selector, value) {
  await browser.execute(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus?.();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    selector,
    value,
  );
}

/** Read an input's current value. */
export async function getInputValue(selector) {
  return browser.execute((sel) => document.querySelector(sel)?.value ?? "", selector);
}

/** Read a localStorage key. */
export async function getLocalStorage(key) {
  return browser.execute((k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }, key);
}
