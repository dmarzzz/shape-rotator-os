import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  syncShapeUi,
  vendorWeb,
} from "./vendor-web.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shape-web-vendor-"));
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

test("vendor:web npm script uses the safe Node vendor script", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.equal(pkg.scripts["vendor:web"], "node scripts/vendor-web.mjs");
});

test("deploy:web does not require a globally installed Vercel CLI", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  assert.match(pkg.scripts["deploy:web"], /npx --yes vercel deploy --prod --yes/);
});

test("Vercel Git deploys rebuild generated web assets before publishing", () => {
  const config = JSON.parse(fs.readFileSync(path.resolve("apps/web/vercel.json"), "utf8"));
  assert.equal(config.buildCommand, "cd ../.. && npm run vendor:web");
  assert.equal(config.outputDirectory, ".");
  assert.match(config.installCommand, /vendor:web/);
});

test("vendorWeb keeps an existing web shape-ui copy when package source is absent", () => {
  const root = tmpRoot();
  write(path.join(root, "apps", "web", "shape-ui", "package.json"), "{\"name\":\"web-copy\"}\n");
  write(path.join(root, "cohort-data", "calendar.json"), "{}\n");
  write(path.join(root, "cohort-data", "calendar.ics"), "BEGIN:VCALENDAR\nEND:VCALENDAR\n");
  write(path.join(root, "apps", "web", "cohort-surface.json"), "{\"surface_visibility\":\"public-web\"}\n");

  const result = vendorWeb({ root, runBuilders: false });

  assert.equal(result.shapeUiMode, "kept-existing-web-copy");
  assert.equal(fs.readFileSync(path.join(root, "apps", "web", "cohort-surface.json"), "utf8"), "{\"surface_visibility\":\"public-web\"}\n");
  assert.equal(fs.existsSync(path.join(root, "apps", "web", "calendar.json")), true);
  assert.equal(fs.existsSync(path.join(root, "apps", "web", "calendar.ics")), true);
});

test("syncShapeUi replaces web vendor copy only from packages/shape-ui", () => {
  const root = tmpRoot();
  write(path.join(root, "packages", "shape-ui", "package.json"), "{\"name\":\"package-copy\"}\n");
  write(path.join(root, "packages", "shape-ui", "src", "index.js"), "export {};\n");
  write(path.join(root, "apps", "web", "shape-ui", "package.json"), "{\"name\":\"old-web-copy\"}\n");

  const mode = syncShapeUi({ root });

  assert.equal(mode, "synced-from-package");
  assert.match(fs.readFileSync(path.join(root, "apps", "web", "shape-ui", "package.json"), "utf8"), /package-copy/);
  assert.equal(fs.existsSync(path.join(root, "apps", "web", "shape-ui", "src", "index.js")), true);
});
