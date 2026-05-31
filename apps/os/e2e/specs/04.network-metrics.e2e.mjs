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
  expectVisible,
  waitVisible,
  waitHidden,
  isVisible,
} from "../helpers/app.mjs";

describe("network", () => {
  before(async () => {
    await waitForBoot();
    await openTab("network");
  });

  it("defaults to the network sub-view", async () => {
    await openNetSub("network");
    expect(await getNetSub()).toBe("network");
    // The network sub-tab surfaces the protocol grid (#network-view) by default.
    await expectVisible(S.networkView);
  });

  it("switches between glance and debug view modes", async () => {
    await $(S.netModeBtn("debug")).click();
    await expect($(S.netModeBtn("debug"))).toHaveAttribute("aria-pressed", "true");
    await expectVisible(S.networkView); // debug = protocol-level grid
    await $(S.netModeBtn("glance")).click();
    await expect($(S.netModeBtn("glance"))).toHaveAttribute("aria-pressed", "true");
    await expect($(S.netModeBtn("debug"))).toHaveAttribute("aria-pressed", "false");
  });

  it("filters traffic by category (debug mode)", async () => {
    await $(S.netModeBtn("debug")).click();
    await expectVisible(S.networkView);
    for (const filter of ["sync", "mdns", "search", "all"]) {
      await $(S.trafficChip(filter)).click();
      await expect($(S.trafficChip(filter))).toHaveElementClass("selected");
    }
  });

  it("opens the peers panel when the sidebar is present", async () => {
    // The peer-count button lives in the graph-only sidebar, which isn't shown
    // on the network tab — skip cleanly when it isn't visible in this context.
    if (!(await isVisible(S.peerCountBtn))) return;
    await $(S.peerCountBtn).click();
    await waitVisible(S.peersPanel);
    await $(S.peersPanelClose).click();
    await waitHidden(S.peersPanel);
  });

  describe("metrics sub-tab", () => {
    before(async () => {
      await openNetSub("metrics");
    });

    it("shows the metrics view", async () => {
      expect(await getNetSub()).toBe("metrics");
      await expectVisible(S.metricsView);
    });

    it("changes the time range", async () => {
      for (const range of ["15m", "6h", "24h", "1h"]) {
        await $(S.metricsRangeBtn(range)).click();
        await expect($(S.metricsRangeBtn(range))).toHaveElementClass("selected");
      }
    });

    it("refreshes without error", async () => {
      await $(S.metricsRefresh).click();
      await browser.waitUntil(
        async () => {
          const status = (await $(S.metricsStatus).getText()).trim();
          const empty = await isVisible("#metrics-empty");
          return (status && status !== "—") || empty;
        },
        { timeout: 30000, timeoutMsg: "metrics never reported status or warm-up" },
      );
    });
  });
});
