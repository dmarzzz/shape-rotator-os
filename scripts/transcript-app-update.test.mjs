import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("transcript app update script is exposed through npm", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["transcripts:app:update"], "node scripts/update-transcript-app-surfaces.mjs");
});

test("package scripts do not expose transcript HTML index output", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["transcripts:index:html"], undefined);
  assert.ok(
    Object.values(pkg.scripts).every((script) => !String(script).includes("build-transcript-talk-index-html.mjs")),
  );
});

test("information rules point transcript catalog review at metadata audits", () => {
  const doc = fs.readFileSync("docs/INFORMATION_RULES.md", "utf8");

  assert.match(doc, /audit-transcript-calendar-coverage\.mjs/);
  assert.match(doc, /audit-transcript-labels\.mjs/);
  assert.match(doc, /supported transcript catalog\/audit workflow/);
  assert.doesNotMatch(doc, /build-transcript-talk-index-html\.mjs/);
});

test("transcript app update keeps the required pipeline order", () => {
  const source = fs.readFileSync("scripts/update-transcript-app-surfaces.mjs", "utf8");
  const exportIndex = source.indexOf("export-transcript-distillations.mjs");
  const articleIndex = source.indexOf("build-public-transcript-articles.mjs");
  const scanIndex = source.indexOf("surface-leak-scan.mjs");
  const vendorIndex = source.indexOf("vendor-web.mjs");
  const insightIndex = source.indexOf("build-cohort-insights.mjs");
  const checkIndex = source.indexOf("build-bundles.js\"), [\"--check\"]");

  assert.ok(exportIndex > 0);
  assert.ok(articleIndex > exportIndex);
  assert.ok(scanIndex > articleIndex);
  assert.ok(vendorIndex > scanIndex);
  assert.ok(insightIndex > vendorIndex);
  assert.ok(checkIndex > insightIndex);
});
