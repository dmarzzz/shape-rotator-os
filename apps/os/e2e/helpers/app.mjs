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
 * Wait until the renderer has booted: tab bar present and the body has settled
 * on an active tab (applyActiveTab runs during boot and sets data-active-tab).
 */
export async function waitForBoot() {
  await $(S.tabBar).waitForExist({ timeout: 90000 });
  await browser.waitUntil(
    async () => {
      const t = await getActiveTab();
      return typeof t === "string" && t.length > 0;
    },
    { timeout: 90000, timeoutMsg: "renderer never set body[data-active-tab]" },
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

/** True if a selector exists and has at least one child element. */
export async function hasChildren(selector) {
  return browser.execute((sel) => {
    const el = document.querySelector(sel);
    return !!el && el.childElementCount > 0;
  }, selector);
}
