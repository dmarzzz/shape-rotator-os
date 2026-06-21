import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("apps/os/src/renderer/cohort-source.js");
const source = fs.readFileSync(sourcePath, "utf8");

test("cohort source reschedules refresh cadence when sync availability changes", () => {
  assert.match(source, /const prevSyncAvailable = !!_cache\?\._syncAvailable;/);
  assert.match(source, /rescheduleRefreshTimerIfNeeded\(prevSyncAvailable\);/);
  assert.match(source, /function refreshIntervalMs\(\) \{\s*return _cache\?\._syncAvailable \? SYNC_REFRESH_MS : REFRESH_MS;\s*\}/);

  const scheduleIndex = source.indexOf("function scheduleRefresh()");
  const intervalIndex = source.indexOf("const interval = refreshIntervalMs();", scheduleIndex);
  const setIntervalIndex = source.indexOf("_refreshTimer = setInterval(refreshTick, interval);", scheduleIndex);

  assert.ok(scheduleIndex > 0);
  assert.ok(intervalIndex > scheduleIndex);
  assert.ok(setIntervalIndex > intervalIndex);
});
