// 00.boot — the app launches, the window paints, the renderer boots to a
// usable state, and the version chip resolves. This is the smoke gate: if it
// fails, nothing downstream is meaningful.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import { waitForBoot, getActiveTab, expectVisible, waitVisible } from "../helpers/app.mjs";

describe("boot", () => {
  before(async () => {
    await waitForBoot();
  });

  it("opens a single window with the right title", async () => {
    await expect(browser).toHaveTitle("Shape Rotator OS");
    const handles = await browser.getWindowHandles();
    expect(handles.length).toBe(1);
  });

  it("renders the primary tab bar with all four tabs", async () => {
    await expectVisible(S.tabBar);
    for (const name of ["alchemy", "apps", "network", "links"]) {
      await expect($(S.tab(name))).toBeExisting();
    }
  });

  it("boots into a valid top tab", async () => {
    // index.html ships data-active-tab="alchemy"; boot may restore a persisted
    // tab, so we only assert it landed on *some* valid tab.
    const tab = await getActiveTab();
    expect(["alchemy", "apps", "network", "links"]).toContain(tab);
  });

  it("resolves the app version chip (not the placeholder)", async () => {
    await waitVisible(S.versionChip, 30000);
    await browser.waitUntil(
      async () => {
        const t = (await $(S.versionChip).getText()).trim();
        return /v?\d+\.\d+\.\d+/.test(t);
      },
      { timeout: 30000, timeoutMsg: "version chip never resolved to a semver" },
    );
  });
});
