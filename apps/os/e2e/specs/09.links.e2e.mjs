// 09.links — the links tab is a set of external resource cards. We assert the
// cards render with safe, correct external hrefs. We deliberately do NOT click
// them: each opens via the OS opener (window.api.openExternal) and would launch
// a real browser as a test side effect.

import { browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import { waitForBoot, openTab, expectVisible } from "../helpers/app.mjs";

// A few stable anchors we expect to always be present.
const EXPECTED = [
  "github.com/dmarzzz/shape-rotator-field-kit",
  "github.com/dmarzzz/shape-rotator-os",
  "shape-rotator-os.vercel.app",
];

function readCards(sel) {
  return Array.from(document.querySelectorAll(sel)).map((a) => ({
    href: a.getAttribute("href") || "",
    target: a.getAttribute("target") || "",
    rel: a.getAttribute("rel") || "",
  }));
}

describe("links", () => {
  before(async () => {
    await waitForBoot();
    await openTab("links");
  });

  it("shows the links view with multiple cards", async () => {
    await expectVisible(S.linksView);
    const count = await browser.execute(
      (sel) => document.querySelectorAll(sel).length,
      S.linkCard,
    );
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it("every card has a safe external href", async () => {
    const cards = await browser.execute(readCards, S.linkCard);
    expect(cards.length).toBeGreaterThanOrEqual(5);
    for (const c of cards) {
      expect(c.href.startsWith("https://")).toBe(true);
      // external links open in a new context and must be noopener-safe
      expect(c.target).toBe("_blank");
      expect(c.rel).toContain("noopener");
    }
  });

  it("includes the key cohort destinations", async () => {
    const cards = await browser.execute(readCards, S.linkCard);
    const hrefs = cards.map((c) => c.href);
    for (const needle of EXPECTED) {
      expect(hrefs.some((h) => h.includes(needle))).toBe(true);
    }
  });
});
