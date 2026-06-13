import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("supabase/functions/review-transcript-artifact/index.ts", "utf8");
const config = fs.readFileSync("supabase/config.toml", "utf8");

test("transcript review function is JWT-verified and coordinator-only", () => {
  assert.match(config, /\[functions\.review-transcript-artifact\]\s+verify_jwt = true/s);
  assert.match(source, /requireOrgRole/);
  assert.match(source, /roles:\s*\["coordinator", "admin"\]/);
});

test("transcript review function records reviews and audit entries", () => {
  assert.match(source, /table:\s*"artifact_reviews"/);
  assert.match(source, /table:\s*"audit_log"/);
  assert.match(source, /derived_artifact\.\$\{reviewStatus\}/);
  assert.match(source, /approval_gate\.\$\{gateStatus\}/);
  assert.match(source, /reviewer_id:\s*actorId/);
});

test("transcript review function guards T3 publication", () => {
  assert.match(source, /T3 publication requires publish_public=true/);
  assert.match(source, /T3 publication requires approval gates/);
  assert.match(source, /T3 publication gate is not cleared/);
  assert.match(source, /T3 publication requires a public_candidate artifact/);
  assert.match(source, /assertNoPublicContentLeak/);
  assert.match(source, /private-vault:/);
  assert.match(source, /drive:\\\/\\\/|drive:\/\//);
  assert.match(source, /storage_ref/);
});
