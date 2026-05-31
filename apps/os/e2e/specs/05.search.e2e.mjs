// 05.search — the network search overlay: open it, configure policy/top_k, run
// a real query, and confirm the app reports a result (meta/status/results).
//
// Live deps: this hits the real swf-node search path. We deliberately leave
// "allow public egress" OFF so the query stays local/cohort and never leaves
// the network as a test side effect.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openApp,
  expectVisible,
  waitVisible,
  anyVisible,
} from "../helpers/app.mjs";

async function openSearch() {
  // The search toggle lives in the tab bar and is revealed on the atlas surface.
  await openApp("atlas");
  await $(S.atlasSearchToggle).click();
  await waitVisible(S.searchView);
}

describe("search", () => {
  before(async () => {
    await waitForBoot();
    await openSearch();
  });

  it("opens the search overlay with its form", async () => {
    await expectVisible(S.searchView);
    await expectVisible(S.searchInput);
    await expectVisible(S.searchSubmit);
  });

  it("exposes policy, egress and top_k controls", async () => {
    await expect($(S.searchPolicy)).toBeExisting();
    await expect($(S.searchEgress)).toBeExisting();
    // egress must default to off — never silently leave the cohort
    expect(await $(S.searchEgress).isSelected()).toBe(false);
    await $(S.searchTopK).selectByAttribute("value", "5");
  });

  it("runs a live local query and reports a result", async () => {
    await $(S.searchPolicy).selectByAttribute("value", "local_only");
    await $(S.searchInput).setValue("shape rotator");
    await $(S.searchSubmit).click();

    // A live search resolves to one of: populated results, a meta line, or a
    // status message (e.g. "no results"). Any of these means the path ran.
    await browser.waitUntil(
      async () => {
        const resultsHaveItems = await browser.execute(
          (sel) =>
            !!document.querySelector(`${sel} [role="listitem"], ${sel} .search-result`),
          S.searchResults,
        );
        if (resultsHaveItems) return true;
        return anyVisible([S.searchMeta, S.searchStatus]);
      },
      { timeout: 60000, timeoutMsg: "search never produced results, meta, or status" },
    );
  });
});
