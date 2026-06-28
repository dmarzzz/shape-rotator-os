import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const sourcePath = path.resolve("apps/os/src/renderer/calendar-timeline-prefs.js");
const source = fs.readFileSync(sourcePath, "utf8");
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const {
  getCalendarTimelinePrefs,
  normalizeCalendarTimelinePrefs,
  setCalendarTimelinePrefs,
  toggleCalendarTimelineCategory,
  toggleCalendarTimelineLane,
} = mod;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
  };
}

test("normalizeCalendarTimelinePrefs keeps only known lanes and categories", () => {
  assert.deepEqual(
    normalizeCalendarTimelinePrefs({
      hiddenLanes: ["activity", "unknown", "presence", "activity"],
      hiddenCategories: ["commit", "bad", "event", "commit"],
    }),
    {
      hiddenLanes: ["activity", "presence"],
      hiddenCategories: ["commit", "event"],
    },
  );
});

test("calendar timeline prefs persist lane and category toggles", () => {
  const storage = memoryStorage();
  assert.deepEqual(getCalendarTimelinePrefs(storage), { hiddenLanes: [], hiddenCategories: [] });

  const laneOff = toggleCalendarTimelineLane("standing", { storage });
  assert.deepEqual(laneOff.hiddenLanes, ["standing"]);
  assert.deepEqual(getCalendarTimelinePrefs(storage).hiddenLanes, ["standing"]);

  const catOff = toggleCalendarTimelineCategory("release", { storage });
  assert.deepEqual(catOff.hiddenCategories, ["release"]);

  const laneOn = toggleCalendarTimelineLane("standing", { storage });
  assert.deepEqual(laneOn.hiddenLanes, []);

  const replaced = setCalendarTimelinePrefs({ hiddenLanes: ["presence"], hiddenCategories: ["event"] }, { storage });
  assert.deepEqual(replaced, { hiddenLanes: ["presence"], hiddenCategories: ["event"] });
});
