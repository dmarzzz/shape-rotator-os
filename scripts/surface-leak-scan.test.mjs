import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MODES,
  scanSurface,
  scanTranscriptText,
  scanWebText,
} from "./surface-leak-scan.mjs";
import { SHARED_PATTERNS } from "./lib/surface-leak-patterns.mjs";

test("both modes include every shared pattern (dedup point lives once)", () => {
  for (const shared of SHARED_PATTERNS) {
    assert.ok(MODES.transcript.patterns.includes(shared), `transcript mode keeps ${shared.label}`);
    assert.ok(MODES.web.patterns.includes(shared), `web mode keeps ${shared.label}`);
  }
});

test("the shared local-user-path leak is caught in BOTH modes", () => {
  const leak = "see C:\\Users\\alice\\vault\\notes.txt";
  assert.deepEqual(scanTranscriptText(leak).map((f) => f.label), ["local user path"]);
  assert.deepEqual(scanWebText(leak).map((f) => f.label), ["local user path"]);
});

test("each mode routes to its own pattern set", () => {
  // An email is a transcript-mode concern, not a web-mode one.
  assert.deepEqual(scanTranscriptText("reach alice@acme.io").map((f) => f.label), ["email address"]);
  assert.deepEqual(scanWebText("reach alice@acme.io"), []);

  // Operator UI copy is a web-mode concern, not a transcript-mode one.
  assert.deepEqual(scanWebText("operator controls").map((f) => f.label), ["calendar operator UI copy"]);
  assert.deepEqual(scanTranscriptText("operator controls"), []);
});

test("scanSurface dedupes files when a target is listed twice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "surface-leak-dedupe-"));
  fs.mkdirSync(path.join(root, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "web", "index.html"), "<div>clean</div>\n");

  const result = scanSurface({ root, mode: "web", targets: ["apps/web", "apps/web/index.html"] });
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.findings, []);
});

test("scanSurface rejects an unknown mode", () => {
  assert.throws(() => scanSurface({ mode: "nope" }), /unknown scan mode/);
});
