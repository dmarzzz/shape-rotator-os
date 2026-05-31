// 01.navigation — the four top tabs switch correctly, mutate
// body[data-active-tab], keep aria-selected in sync (one selected at a time),
// reveal the right view, and the choice persists across a reload.

import { $, browser, expect } from "@wdio/globals";
import { S, TOP_TABS } from "../helpers/selectors.mjs";
import { waitForBoot, openTab, getActiveTab } from "../helpers/app.mjs";

const VIEW_FOR = {
  alchemy: S.alchemyView,
  network: S.networkView,
  links: S.linksView,
  // apps view depends on the persisted apps sub-view (grid|atlas|easel), so it
  // is asserted in the apps spec rather than here.
};

describe("navigation", () => {
  before(async () => {
    await waitForBoot();
  });

  for (const tab of TOP_TABS) {
    it(`switches to "${tab}"`, async () => {
      await openTab(tab);
      expect(await getActiveTab()).toBe(tab);
      if (VIEW_FOR[tab]) await expect($(VIEW_FOR[tab])).toBeDisplayed();
    });
  }

  it("keeps exactly one tab aria-selected", async () => {
    await openTab("network");
    const selected = await browser.execute(() =>
      Array.from(document.querySelectorAll('#tab-bar .tab-btn'))
        .filter((b) => b.getAttribute("aria-selected") === "true")
        .map((b) => b.dataset.tab),
    );
    expect(selected).toEqual(["network"]);
  });

  it("persists the active tab across a reload", async () => {
    await openTab("links");
    await browser.refresh();
    await waitForBoot();
    expect(await getActiveTab()).toBe("links");
  });
});
