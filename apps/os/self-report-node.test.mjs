import test from "node:test";
import assert from "node:assert/strict";

import { resolveCommand, splitCommand } from "./self-report-node.js";

test("splitCommand respects single/double quotes, no expansion", () => {
  assert.deepEqual(splitCommand("claude -p"), ["claude", "-p"]);
  assert.deepEqual(splitCommand('"C:/a b/x.exe" exec model'), ["C:/a b/x.exe", "exec", "model"]);
  assert.deepEqual(splitCommand("codex 'a b' c"), ["codex", "a b", "c"]);
  assert.deepEqual(splitCommand(""), []);
  assert.deepEqual(splitCommand(null), []);
});

test("resolveCommand prefers an explicit chatCmd (no PATH probe)", () => {
  assert.deepEqual(resolveCommand("mycli --flag"), ["mycli", "--flag"]);
  assert.deepEqual(resolveCommand('"x y/z.exe" exec -'), ["x y/z.exe", "exec", "-"]);
});

test("resolveCommand falls back to COHORT_CHAT_CMD env when chatCmd is empty", () => {
  const prev = process.env.COHORT_CHAT_CMD;
  process.env.COHORT_CHAT_CMD = "envcli run";
  try {
    assert.deepEqual(resolveCommand(""), ["envcli", "run"]);
    assert.deepEqual(resolveCommand("   "), ["envcli", "run"]);
  } finally {
    if (prev === undefined) delete process.env.COHORT_CHAT_CMD;
    else process.env.COHORT_CHAT_CMD = prev;
  }
});
