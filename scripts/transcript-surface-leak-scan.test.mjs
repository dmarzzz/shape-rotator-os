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
