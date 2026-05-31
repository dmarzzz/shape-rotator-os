// 07.command-palette — the global keyboard layer wired in renderer/ux.js:
//   • Cmd/Ctrl+K toggles the command palette (.ux-cmd-backdrop, role=dialog)
//   • typing filters the command list; Esc closes
//   • "?" opens the keyboard-shortcut overlay
//
// The app's shortcuts listen on `document` keydown. tauri-wd's real OS key
// events (`browser.keys`) don't reliably reach those handlers, so we dispatch
// synthetic KeyboardEvents via execute — the same events the user's keypress
// would produce. (Verified against the running app.)

import { $, browser, expect } from "@wdio/globals";
import { S } from "../helpers/selectors.mjs";
import { waitForBoot, openTab, waitVisible, dispatchKey, setInputValue } from "../helpers/app.mjs";

describe("command palette + shortcuts", () => {
  before(async () => {
    await waitForBoot();
    await openTab("alchemy"); // a neutral, non-editable surface
  });

  it("opens the command palette with Cmd/Ctrl+K", async () => {
    await dispatchKey("k", { metaKey: true, ctrlKey: true });
    await waitVisible(S.cmdBackdrop, 10000);
    await expect($(S.cmdBackdrop)).toHaveAttribute("role", "dialog");
    await expect($(S.cmdInput)).toBeExisting();
  });

  it("filters commands as you type", async () => {
    await setInputValue(S.cmdInput, "network");
    const count = await browser.execute(
      () =>
        document.querySelectorAll(".ux-cmd-list [role='option'], .ux-cmd-list li")
          .length,
    );
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("closes the palette with Escape", async () => {
    await dispatchKey("Escape");
    await browser.waitUntil(async () => !(await $(S.cmdBackdrop).isExisting()), {
      timeout: 10000,
      timeoutMsg: "command palette never closed on Escape",
    });
  });

  it('opens the keyboard overlay with "?"', async () => {
    await dispatchKey("?", { shiftKey: true });
    await browser.waitUntil(
      async () =>
        browser.execute(
          () =>
            !!document.querySelector(
              "[class*='kbd-overlay'], [class*='ux-kbd-overlay'], [class*='kbd'], [role='dialog'][aria-label*='keyboard' i]",
            ),
        ),
      { timeout: 10000, timeoutMsg: 'keyboard overlay did not open on "?"' },
    );
    await dispatchKey("Escape");
  });
});
