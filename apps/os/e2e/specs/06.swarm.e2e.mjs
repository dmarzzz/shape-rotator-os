// 06.swarm — the "ask my agent" swarm panel: it opens as a modal dialog,
// exposes the query form + model picker, opens/closes its settings sub-modal,
// and dismisses cleanly. We do NOT start a real swarm run (that spends real LLM
// tokens / requires a configured key) — that's an opt-in flow, not a smoke path.

import { $, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import {
  waitForBoot,
  openApp,
  expectVisible,
  waitVisible,
  waitHidden,
  setInputValue,
  getInputValue,
} from "../helpers/app.mjs";

async function openSwarm() {
  await openApp("atlas");
  await $(S.atlasSearchToggle).click();
  await waitVisible(S.searchView);
  await $(S.searchAskAgent).click();
  await waitVisible(S.swarmPanel);
}

describe("swarm (ask my agent)", () => {
  before(async () => {
    await waitForBoot();
    await openSwarm();
  });

  it("opens as an accessible modal dialog", async () => {
    await expectVisible(S.swarmPanel);
    await expect($(S.swarmPanel)).toHaveAttribute("role", "dialog");
    await expect($(S.swarmPanel)).toHaveAttribute("aria-modal", "true");
    await expectVisible(S.swarmQuery);
    await expect($(S.swarmModel)).toBeExisting();
    await expectVisible(S.swarmStart);
  });

  it("opens and closes the settings sub-modal", async () => {
    await $(S.swarmSettingsBtn).click();
    await waitVisible(S.swarmSettings);
    await expectVisible(S.swarmAnthropicKey);
    // key field must be a password input — never plaintext on screen
    await expect($(S.swarmAnthropicKey)).toHaveAttribute("type", "password");
    await $(S.swarmSettingsClose).click();
    await waitHidden(S.swarmSettings);
  });

  it("accepts a query without auto-running", async () => {
    await setInputValue(S.swarmQuery, "what is the cohort working on?");
    expect(await getInputValue(S.swarmQuery)).toContain("cohort");
    // status stays idle until the user presses start
    await expect($("#swarm-status-line")).toHaveText("idle");
  });

  it("closes via its close affordance", async () => {
    // first matching [data-swarm-close] is the header ✕ / backdrop
    await $(S.swarmClose).click();
    await waitHidden(S.swarmPanel);
  });
});
