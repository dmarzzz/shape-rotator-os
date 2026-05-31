// 04.network — the network tab, its two sub-views (network | metrics), the
// glance/debug mode switch, traffic filter chips, the peers panel, and the
// metrics range switch + refresh. Fully live against swf-node: peer/traffic
// counts may be zero, so we assert structure + interactivity, not magnitudes.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openTab,
  openNetSub,
  getNetSub,
} from "../helpers/app.mjs";

describe("network", () => {
  before(async () => {
    await waitForBoot();
    await openTab("network");
  });

  it("defaults to the network sub-view", async () => {
    await openNetSub("network");
    expect(await getNetSub()).toBe("network");
    // glance is the default view-mode surface
    await expect($(S.glanceView)).toBeDisplayed();
  });

  it("switches between glance and debug view modes", async () => {
    await $(S.netModeBtn("debug")).click();
    await expect($(S.netModeBtn("debug"))).toHaveAttribute("aria-pressed", "true");
    await expect($(S.networkView)).toBeDisplayed(); // debug = protocol-level grid
    await $(S.netModeBtn("glance")).click();
    await expect($(S.netModeBtn("glance"))).toHaveAttribute("aria-pressed", "true");
  });

  it("filters traffic by category (debug mode)", async () => {
    await $(S.netModeBtn("debug")).click();
    for (const filter of ["sync", "mdns", "search", "all"]) {
      await $(S.trafficChip(filter)).click();
      await expect($(S.trafficChip(filter))).toHaveElementClass("selected");
    }
  });

  it("opens the peers panel from the sidebar footer", async () => {
    // The peer-count button lives in the graph sidebar; ensure it's reachable.
    if (await $(S.peerCountBtn).isExisting()) {
      await $(S.peerCountBtn).click();
      await expect($(S.peersPanel)).toBeDisplayed();
      await $(S.peersPanelClose).click();
      await expect($(S.peersPanel)).not.toBeDisplayed();
    }
  });

  describe("metrics sub-tab", () => {
    before(async () => {
      await openNetSub("metrics");
    });

    it("shows the metrics view", async () => {
      expect(await getNetSub()).toBe("metrics");
      await expect($(S.metricsView)).toBeDisplayed();
    });

    it("changes the time range", async () => {
      for (const range of ["15m", "6h", "24h", "1h"]) {
        await $(S.metricsRangeBtn(range)).click();
        await expect($(S.metricsRangeBtn(range))).toHaveElementClass("selected");
      }
    });

    it("refreshes without error", async () => {
      await $(S.metricsRefresh).click();
      // status line should update to something non-placeholder within a beat,
      // or the warm-up empty-state should show — either is a valid live result.
      await browser.waitUntil(
        async () => {
          const status = (await $(S.metricsStatus).getText()).trim();
          const empty = await $("#metrics-empty").isDisplayed().catch(() => false);
          return (status && status !== "—") || empty;
        },
        { timeout: 30000, timeoutMsg: "metrics never reported status or warm-up" },
      );
    });
  });
});
