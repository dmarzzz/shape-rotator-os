// 10.theme — the light/dark theme toggle (in the operating-system views). It
// flips documentElement[data-theme] and persists the choice to localStorage
// (srwk:theme), so it's restored on next launch.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openAlchemyMode,
  getLocalStorage,
  waitVisible,
} from "../helpers/app.mjs";

const htmlTheme = () =>
  browser.execute(() => document.documentElement.dataset.theme || "");

const toggleExists = () =>
  browser.execute(() => !!document.getElementById("alch-theme-toggle"));

describe("theme toggle", () => {
  before(async () => {
    await waitForBoot();
    // The theme toggle is part of the alchemy view chrome, but some modes (e.g.
    // the membrane's 3D canvas) render it late or not at all — find a mode where
    // it's present rather than assuming one.
    let found = false;
    for (const m of ["profile", "program", "onboarding", "membrane"]) {
      await openAlchemyMode(m);
      // openAlchemyMode only waits for the rail button to select, not for the
      // canvas (where the toggle renders) to mount — poll each mode briefly.
      try {
        await browser.waitUntil(toggleExists, { timeout: 8000, interval: 500 });
        found = true;
        break;
      } catch {
        /* try the next mode */
      }
    }
    expect(found).toBe(true);
    await waitVisible(S.themeToggle);
  });

  it("flips the document theme and persists it", async () => {
    const before = await htmlTheme();
    expect(["dark", "light"]).toContain(before);

    await $(S.themeToggle).click();
    await browser.waitUntil(async () => (await htmlTheme()) !== before, {
      timeout: 10000,
      timeoutMsg: "theme never flipped after toggle",
    });

    const after = await htmlTheme();
    expect(after).not.toBe(before);
    // the new choice is persisted (restored on next launch)
    expect(await getLocalStorage("srwk:theme")).toBe(after);
  });

  it("toggles back to the original theme", async () => {
    const current = await htmlTheme();
    await $(S.themeToggle).click();
    await browser.waitUntil(async () => (await htmlTheme()) !== current, {
      timeout: 10000,
      timeoutMsg: "theme never toggled back",
    });
    expect(await getLocalStorage("srwk:theme")).toBe(await htmlTheme());
  });
});
