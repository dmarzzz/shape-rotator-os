import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Files that ship to the public repo / OS bundle. The generated calendar
// surface and the committed export must stay free of source-calendar
// identifiers and per-event deep-link metadata; the build sanitizer
// (publicCalendarGoogleEvents) and the export stripper enforce this, and this
// scan is the CI backstop that keeps regressions from slipping in.
const COMMITTED_FILES = [
  "apps/os/src/cohort-surface.json",
  "cohort-data/calendar-google-events.json",
];

// Each pattern matches a source-calendar identifier or a per-event link field
// that should never appear in a committed surface.
const FORBIDDEN_PATTERNS = [
  { label: "source calendar id", re: /c_[0-9a-f]{30,}@(?:group\.calendar\.)?google\.com/i },
  { label: "html_link field", re: /"html_link"\s*:/ },
  { label: "google_event_id field", re: /"google_event_id"\s*:/ },
  { label: "calendar event deep link", re: /google\.com\/calendar\/event\?eid=/i },
];

for (const file of COMMITTED_FILES) {
  test(`committed calendar surface stays free of source-calendar identifiers: ${file}`, () => {
    const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const { label, re } of FORBIDDEN_PATTERNS) {
      assert.ok(!re.test(raw), `${file} must not contain ${label}`);
    }
  });
}
