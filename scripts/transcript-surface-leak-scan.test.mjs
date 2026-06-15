import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanPublicSurfaces,
  scanText,
} from "./transcript-surface-leak-scan.mjs";

test("transcript surface leak scanner detects private transcript markers", () => {
  const findings = scanText(JSON.stringify({
    source_artifact_id: "source_1",
    storage_ref: "drive://drive_file_1",
    contact: "guest@example.com",
  }));

  assert.deepEqual(
    findings.map((finding) => finding.label).sort(),
    ["Drive source ref", "email address", "source artifact id field", "storage ref field"].sort(),
  );
});

test("transcript surface leak scanner flags parenthesized recording timecodes", () => {
  // An attributed quote carrying a recording timecode is a transcript artifact.
  assert.deepEqual(
    scanText('"the June plan includes week one at IC3" — Tina, Apr 27 (00:14:41)')
      .map((finding) => finding.label),
    ["transcript timecode"],
  );

  // Schedule ranges use H:MM (no seconds) and must NOT trip the timecode rule.
  assert.deepEqual(
    scanText("16:00 - 19:00 Project Intros (Salon room)")
      .filter((finding) => finding.label === "transcript timecode"),
    [],
  );
});

test("transcript surface leak scanner accepts clean generalized article output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-leak-scan-"));
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "public", "manifest.json"), JSON.stringify({
    article_mode: "generalized_no_named_insights",
    named_entities_allowed: false,
    articles: [{ title: "Reusable insight", summary: "Teams need evidence before weekly synthesis." }],
  }, null, 2));
  fs.writeFileSync(path.join(root, "public", "article.md"), [
    "# Reusable insight",
    "",
    "A general pattern for converting meeting output into reviewed evidence.",
    "",
  ].join("\n"));

  const result = scanPublicSurfaces({ root, targets: ["public"] });

  assert.equal(result.files.length, 2);
  assert.deepEqual(result.findings, []);
});

test("current generated app/public transcript surfaces do not expose private transcript markers", () => {
  const result = scanPublicSurfaces();

  assert.ok(result.files.length >= 2);
  assert.deepEqual(result.findings, []);
});

test("email allowlist clears Google Calendar system IDs but still flags real PII", () => {
  // A shared Google Calendar group ID is email-shaped (c_<hash>@group.calendar.
  // google.com) but is NOT a personal email address, so it must be allowlisted.
  // This is a DATA-INDEPENDENT contract test: unlike the live-surface test above,
  // it holds even if the generated artifact stops containing a calendar ID, and it
  // fails loudly if a future edit weakens the allowlist (e.g. drops the `$` anchor).
  const emailFindings = (text) =>
    scanText(text).filter((finding) => finding.label === "email address");

  // 1. A bare Google Calendar system ID is not PII -> allowlisted, no finding.
  assert.deepEqual(emailFindings("c_d3c5ef@group.calendar.google.com"), []);
  assert.deepEqual(emailFindings("room@resource.calendar.google.com"), []);

  // 2. A genuine personal email is still flagged.
  assert.equal(emailFindings("reach alice@acme.io for access").length, 1);

  // 3. Anchor guard: a real domain suffixed after the calendar host must NOT be
  //    cleared by the allowlist. If the `$` anchor is ever dropped, this fails.
  assert.equal(emailFindings("evil@group.calendar.google.com.attacker.com").length, 1);

  // 4. A calendar ID and a real email on the same line: the real one still
  //    surfaces, proving we iterate every match instead of stopping at the first.
  const mixed = emailFindings("cal c_x@group.calendar.google.com owner jane@corp.io");
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].excerpt, "jane@corp.io");
});
