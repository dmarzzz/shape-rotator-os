import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  scanWebText as scanText,
  scanWebSurfaces as scanWebPublicSurface,
} from "./surface-leak-scan.mjs";

test("web public surface scanner detects calendar operator leakage", () => {
  const findings = scanText(`
    <section id="calendar-ingress"></section>
    <h2>operator controls</h2>
    <span>Supabase anon key</span>
    fetch("/rest/v1/private_invite_contacts");
  `);

  assert.deepEqual(
    findings.map((finding) => finding.label).sort(),
    [
      "browser credential prompt",
      "calendar admin endpoint or table",
      "calendar ingress operator asset",
      "calendar operator UI copy",
    ].sort(),
  );
});

test("web public surface scanner detects displayed private source fields", () => {
  const findings = scanText(`
    const label = claim.source_artifact_id || "evidence card";
    const row = { "storage_ref": "drive://secret" };
  `);

  assert.deepEqual(
    findings.map((finding) => finding.label),
    ["private source marker"],
  );
});

test("web public surface scanner accepts ordinary calendar rendering code", () => {
  const findings = scanText(`
    <section class="cal-export" aria-label="calendar subscription"></section>
    import { renderWeekView } from "@shape-rotator/shape-ui";
    const href = "/calendar.ics";
  `);

  assert.deepEqual(findings, []);
});

test("current static web app does not ship calendar operator surfaces", () => {
  const result = scanWebPublicSurface();

  assert.ok(result.files.length >= 5);
  assert.deepEqual(result.findings, []);
});

test("web public surface scanner handles custom roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-public-leak-scan-"));
  fs.mkdirSync(path.join(root, "apps", "web", "calendar"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "web", "calendar", "index.html"), "<div>calendar</div>\n");
  fs.writeFileSync(path.join(root, "apps", "web", "calendar", "notes.md"), "public calendar note\n");

  const result = scanWebPublicSurface({ root });

  assert.equal(result.files.length, 2);
  assert.deepEqual(result.findings, []);
});

test("web public surface scanner includes shipped Markdown pages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-public-md-scan-"));
  fs.mkdirSync(path.join(root, "apps", "web", "workspace"), { recursive: true });
  fs.writeFileSync(path.join(root, "apps", "web", "workspace", "index.md"), "source_artifact_id: abc\n");

  const result = scanWebPublicSurface({ root });

  assert.equal(result.files.length, 1);
  assert.deepEqual(result.findings.map((finding) => finding.label), ["private source marker"]);
});
