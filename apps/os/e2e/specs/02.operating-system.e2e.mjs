// 02.operating-system — the alchemy "operating system" tab and its left rail.
// Every rail mode should mount something into #alchemy-canvas and mark itself
// aria-selected. The membrane (default) should bring up its WebGL surface.

import { $, browser, expect } from "@wdio/globals";
import { S, ALCHEMY_MODES } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openTab,
  openAlchemyMode,
  expectVisible,
  hasChildren,
} from "../helpers/app.mjs";

describe("operating system (alchemy)", () => {
  before(async () => {
    await waitForBoot();
    await openTab("alchemy");
  });

  it("shows the operating-system view and its rail", async () => {
    await expectVisible(S.alchemyView);
    await expect($(S.alchRailBtn("membrane"))).toBeExisting();
  });

  it("renders a WebGL/canvas surface for the membrane", async () => {
    await openAlchemyMode("membrane");
    await browser.waitUntil(
      async () =>
        browser.execute(() => !!document.querySelector("#alchemy-view canvas")),
      { timeout: 30000, timeoutMsg: "membrane never mounted a canvas" },
    );
  });

  for (const mode of ALCHEMY_MODES) {
    it(`mounts the "${mode}" rail mode`, async () => {
      await openAlchemyMode(mode);
      await browser.waitUntil(() => hasChildren(S.alchemyCanvas), {
        timeout: 30000,
        timeoutMsg: `alchemy canvas stayed empty for mode "${mode}"`,
      });
    });
  }

  it("keeps exactly one rail mode aria-selected", async () => {
    await openAlchemyMode("calendar");
    const selected = await browser.execute(() =>
      Array.from(document.querySelectorAll(".alchemy-rail-btn"))
        .filter((b) => b.getAttribute("aria-selected") === "true")
        .map((b) => b.dataset.alchMode),
    );
    expect(selected).toEqual(["calendar"]);
  });
});
