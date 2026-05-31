// 01.navigation — the four top tabs switch correctly, mutate
// body[data-active-tab], keep aria-selected in sync (one selected at a time),
// reveal the right view, and the choice persists across a reload.

import { browser, expect } from "@wdio/globals";
import { S, TOP_TABS } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openTab,
  getActiveTab,
  expectVisible,
  anyVisible,
  getLocalStorage,
} from "../helpers/app.mjs";

// Surfaces that must be visible once a tab is active. network/apps have
// persisted sub-states (sub-tab, view-mode, grid|atlas|easel) carried in the
// shared user-data-dir localStorage, so we accept any of their valid surfaces.
const VIEW_FOR = {
  alchemy: [S.alchemyView],
  apps: [S.appsGrid, S.atlasView, S.easelView],
  network: [S.glanceView, S.networkView, S.metricsView],
  links: [S.linksView],
};

describe("navigation", () => {
  before(async () => {
    await waitForBoot();
  });

  for (const tab of TOP_TABS) {
    it(`switches to "${tab}"`, async () => {
      await openTab(tab);
      expect(await getActiveTab()).toBe(tab);
      const surfaces = VIEW_FOR[tab];
      if (surfaces.length === 1) {
        await expectVisible(surfaces[0]);
      } else {
        await browser.waitUntil(() => anyVisible(surfaces), {
          timeout: 20000,
          timeoutMsg: `no expected surface visible for "${tab}"`,
        });
      }
    });
  }

  it("keeps exactly one tab aria-selected", async () => {
    await openTab("network");
    const selected = await browser.execute(() =>
      Array.from(document.querySelectorAll("#tab-bar .tab-btn"))
        .filter((b) => b.getAttribute("aria-selected") === "true")
        .map((b) => b.dataset.tab),
    );
    expect(selected).toEqual(["network"]);
  });

  it("persists the active tab to storage (restored on next launch)", async () => {
    // boot.js restores the active tab from localStorage on launch; we assert the
    // persistence mechanism directly rather than via browser.refresh(), which
    // doesn't reliably preserve the webview's localStorage under the driver.
    await openTab("links");
    expect(await getLocalStorage("srwk:active_tab")).toBe("links");
    await openTab("alchemy");
    expect(await getLocalStorage("srwk:active_tab")).toBe("alchemy");
  });
});
