// 03.apps — the apps grid opens the two tools (atlas, easel), the back button
// returns to the grid, and atlas resolves to one of its three known states
// (populated stage / index-empty / daemon-offline). Live: which state appears
// depends on whether swf-node is up and has data yet, so we accept any.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openTab,
  openApp,
  getAppsView,
  anyDisplayed,
} from "../helpers/app.mjs";

describe("apps", () => {
  before(async () => {
    await waitForBoot();
    await openTab("apps");
  });

  it("shows the apps grid with atlas + easel cards", async () => {
    await expect($(S.appsGrid)).toBeDisplayed();
    await expect($(S.appCard("atlas"))).toBeDisplayed();
    await expect($(S.appCard("easel"))).toBeDisplayed();
  });

  describe("atlas", () => {
    before(async () => {
      await openApp("atlas");
    });

    it("opens the atlas view", async () => {
      await expect($(S.atlasView)).toBeDisplayed();
      expect(await getAppsView()).toBe("atlas");
    });

    it("settles into a known state (stage | empty | offline)", async () => {
      await browser.waitUntil(
        async () => {
          const stageHasContent = await browser.execute((sel) => {
            const el = document.querySelector(sel);
            return !!el && (el.childElementCount > 0 || !!el.querySelector("canvas, svg"));
          }, S.atlasStage);
          if (stageHasContent) return true;
          return anyDisplayed([S.atlasEmpty, S.atlasOffline]);
        },
        {
          timeout: 45000,
          timeoutMsg: "atlas never reached stage/empty/offline",
        },
      );
    });

    it("toggles the help panel", async () => {
      await $(S.atlasHelpToggle).click();
      await expect($(S.atlasHelpPanel)).toBeDisplayed();
      await expect($(S.atlasHelpToggle)).toHaveAttribute("aria-expanded", "true");
      // close it again via its own ✕
      await $(`${S.atlasHelpPanel} .ahp-close`).click();
      await expect($(S.atlasHelpPanel)).not.toBeDisplayed();
    });

    it("returns to the apps grid via back", async () => {
      await $(S.appsBack).click();
      await browser.waitUntil(async () => (await getAppsView()) === "grid", {
        timeout: 15000,
        timeoutMsg: "atlas back never returned to the grid",
      });
      await expect($(S.appsGrid)).toBeDisplayed();
    });
  });

  describe("easel", () => {
    it("opens and returns to the grid", async () => {
      await openApp("easel");
      await expect($(S.easelView)).toBeDisplayed();
      await $(S.appsBack).click();
      await browser.waitUntil(async () => (await getAppsView()) === "grid", {
        timeout: 15000,
        timeoutMsg: "easel back never returned to the grid",
      });
    });
  });
});
