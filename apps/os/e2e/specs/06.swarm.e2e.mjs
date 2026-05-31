// 06.swarm — the "ask my agent" swarm panel: it opens as a modal dialog,
// exposes the query form + model picker, opens/closes its settings sub-modal,
// and dismisses cleanly. We do NOT start a real swarm run (that spends real LLM
// tokens / requires a configured key) — that's an opt-in flow, not a smoke path.

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import { waitForBoot, openApp } from "../helpers/app.mjs";

async function openSwarm() {
  await openApp("atlas");
  await $(S.atlasSearchToggle).click();
  await $(S.searchView).waitForDisplayed({ timeout: 15000 });
  await $(S.searchAskAgent).click();
  await $(S.swarmPanel).waitForDisplayed({ timeout: 15000 });
}

describe("swarm (ask my agent)", () => {
  before(async () => {
    await waitForBoot();
    await openSwarm();
  });

  it("opens as an accessible modal dialog", async () => {
    await expect($(S.swarmPanel)).toBeDisplayed();
    await expect($(S.swarmPanel)).toHaveAttribute("role", "dialog");
    await expect($(S.swarmPanel)).toHaveAttribute("aria-modal", "true");
    await expect($(S.swarmQuery)).toBeDisplayed();
    await expect($(S.swarmModel)).toBeExisting();
    await expect($(S.swarmStart)).toBeDisplayed();
  });

  it("opens and closes the settings sub-modal", async () => {
    await $(S.swarmSettingsBtn).click();
    await expect($(S.swarmSettings)).toBeDisplayed();
    await expect($(S.swarmAnthropicKey)).toBeDisplayed();
    // key field must be a password input — never plaintext on screen
    await expect($(S.swarmAnthropicKey)).toHaveAttribute("type", "password");
    await $(S.swarmSettingsClose).click();
    await expect($(S.swarmSettings)).not.toBeDisplayed();
  });

  it("accepts a query without auto-running", async () => {
    await $(S.swarmQuery).setValue("what is the cohort working on?");
    expect(await $(S.swarmQuery).getValue()).toContain("cohort");
    // status stays idle until the user presses start
    await expect($("#swarm-status-line")).toHaveText("idle");
  });

  it("closes via its close affordance", async () => {
    // first matching [data-swarm-close] is the header ✕ / backdrop
    await $(S.swarmClose).click();
    await expect($(S.swarmPanel)).not.toBeDisplayed();
  });
});
