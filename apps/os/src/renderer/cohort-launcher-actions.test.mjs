import assert from "node:assert/strict";
import test from "node:test";

import { launcherStatus, normalizeLauncherAction } from "./cohort-launcher-actions.mjs";

test("launcher actions normalize legacy aliases", () => {
  assert.equal(normalizeLauncherAction("updates"), "sync");
  assert.equal(normalizeLauncherAction("sync"), "sync");
  assert.equal(normalizeLauncherAction("transcript"), "transcript");
  assert.equal(normalizeLauncherAction("nope"), "chat");
  assert.equal(normalizeLauncherAction(""), "chat");
});

test("launcher status copy keeps compact tool labels", () => {
  assert.deepEqual(launcherStatus("sync", "busy"), {
    state: "busy",
    label: "syncing",
    hint: "opening review",
  });
  assert.deepEqual(launcherStatus("updates", "done"), {
    state: "done",
    label: "sync",
    hint: "ready",
    ttl: 5000,
  });
  assert.deepEqual(launcherStatus("transcript", "done"), {
    state: "done",
    label: "add",
    hint: "ready",
    ttl: 5000,
  });
});
