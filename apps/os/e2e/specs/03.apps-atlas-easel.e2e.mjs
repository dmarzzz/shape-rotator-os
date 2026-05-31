// 03.apps — the apps grid opens the two tools (atlas, easel), the back button
// returns to the grid, and atlas resolves to one of its three known states
// (populated stage / index-empty / daemon-offline). Live: which state appears
// depends on whether swf-node is up and has data yet, so we accept any.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openApp,
  getAppsView,
  gotoAppsGrid,
  expectVisible,
  waitVisible,
  waitHidden,
  anyVisible,
} from "../helpers/app.mjs";

describe("apps", () => {
  before(async () => {
    await waitForBoot();
    await gotoAppsGrid();
  });

  it("shows the apps grid with atlas + easel cards", async () => {
    await expectVisible(S.appsGrid);
    await expectVisible(S.appCard("atlas"));
    await expectVisible(S.appCard("easel"));
  });

  describe("atlas", () => {
    before(async () => {
      await openApp("atlas");
    });

    it("opens the atlas view", async () => {
      await expectVisible(S.atlasView);
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
          return anyVisible([S.atlasEmpty, S.atlasOffline]);
        },
        { timeout: 45000, timeoutMsg: "atlas never reached stage/empty/offline" },
      );
    });

    it("toggles the help panel", async () => {
      await $(S.atlasHelpToggle).click();
      await waitVisible(S.atlasHelpPanel);
      await expect($(S.atlasHelpToggle)).toHaveAttribute("aria-expanded", "true");
      await $(`${S.atlasHelpPanel} .ahp-close`).click();
      await waitHidden(S.atlasHelpPanel);
    });

    it("returns to the apps grid via back", async () => {
      // Two [data-apps-back] buttons exist (atlas + easel); click the atlas one.
      // Back clears body[data-apps-view] (→ grid), it does not set it to "grid".
      await $(`${S.atlasView} ${S.appsBack}`).click();
      await waitVisible(S.appsGrid);
      expect(await getAppsView()).not.toBe("atlas");
    });
  });

  describe("easel", () => {
    it("opens and returns to the grid", async () => {
      await openApp("easel");
      await expectVisible(S.easelView);
      await $(`${S.easelView} ${S.appsBack}`).click();
      await waitVisible(S.appsGrid);
      expect(await getAppsView()).not.toBe("easel");
    });
  });
});
