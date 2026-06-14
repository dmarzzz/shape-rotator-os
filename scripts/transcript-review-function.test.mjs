import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync("supabase/functions/review-transcript-artifact/index.ts", "utf8");
const safetySource = fs.readFileSync("supabase/functions/_shared/transcript_safety.ts", "utf8");
const config = fs.readFileSync("supabase/config.toml", "utf8");

test("transcript review function is JWT-verified and coordinator-only", () => {
  assert.match(config, /\[functions\.review-transcript-artifact\]\s+verify_jwt = true/s);
  assert.match(source, /requireOrgRole/);
  assert.match(source, /roles:\s*\["coordinator", "admin"\]/);
});

test("transcript review function records reviews and audit entries", () => {
  assert.match(source, /table:\s*"artifact_reviews"/);
  assert.match(source, /table:\s*"audit_log"/);
  assert.match(source, /object_type:\s*"evidence_card"/);
  assert.match(source, /derived_artifact\.\$\{reviewStatus\}/);
  assert.match(source, /evidence_card\.\$\{reviewStatus\}/);
  assert.match(source, /approval_gate\.\$\{gateStatus\}/);
  assert.match(source, /reviewer_id:\s*actorId/);
});

test("transcript review function guards T3 publication", () => {
  assert.match(source, /T3 publication requires publish_public=true/);
  assert.match(source, /T3 publication requires approval gates/);
  assert.match(source, /T3 publication gate is not cleared/);
  assert.match(source, /T3 publication requires a public_candidate artifact/);
  assert.match(source, /assertTranscriptSurfaceSafe/);
  assert.match(source, /assertArtifactSurfaceSafe/);
  assert.match(source, /assertEvidenceCardSurfaceSafe/);
  assert.match(safetySource, /private-vault:/);
  assert.match(safetySource, /drive:\\\/\\\/|drive:\/\//);
  assert.match(safetySource, /storage_ref/);
  assert.match(safetySource, /raw\[-_ \]\?transcript/);
});

test("transcript review function can review evidence cards without direct table writes from the browser", () => {
  assert.match(source, /review_evidence_card/);
  assert.match(source, /fetchEvidenceCard/);
  assert.match(source, /patchEvidenceCard/);
  assert.match(source, /T3 evidence-card publication requires publish_public=true/);
  assert.match(source, /T3 evidence cards must be no-named generalized insights/);
  assert.match(source, /evidenceCardEditPatch/);
  assert.match(source, /content_md/);
  assert.match(source, /claim_text/);
  assert.match(source, /confidence must be between 0 and 1/);
});

test("transcript review function applies edits before promotion checks", () => {
  assert.match(source, /artifactEditPatch/);
  assert.match(source, /const candidate = \{ \.\.\.artifact, \.\.\.patch \}/);
  assert.match(source, /artifact: candidate/);
  assert.match(source, /const candidate = \{ \.\.\.card, \.\.\.patch \}/);
  assert.match(source, /fetchEvidenceCardsForArtifact/);
});
