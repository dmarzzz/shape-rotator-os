import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("transcript app update script is exposed through npm", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["transcripts:app:update"], "node scripts/update-transcript-app-surfaces.mjs");
});

test("transcript app update keeps the required pipeline order", () => {
  const source = fs.readFileSync("scripts/update-transcript-app-surfaces.mjs", "utf8");
  const exportIndex = source.indexOf("export-transcript-distillations.mjs");
  const articleIndex = source.indexOf("build-public-transcript-articles.mjs");
  const scanIndex = source.indexOf("transcript-surface-leak-scan.mjs");
  const vendorIndex = source.indexOf("vendor-web.mjs");
  const checkIndex = source.indexOf("build-bundles.js\"), [\"--check\"]");

  assert.ok(exportIndex > 0);
  assert.ok(articleIndex > exportIndex);
  assert.ok(scanIndex > articleIndex);
  assert.ok(vendorIndex > scanIndex);
  assert.ok(checkIndex > vendorIndex);
});
