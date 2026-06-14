import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSurface(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function timelineEvidence(surface, key) {
  return Object.values(surface[key] || {})
    .flat()
    .filter((item) => item.type === "transcript evidence");
}

function assertInternalSurfaceOmitsCommittedTranscriptEvidence(surface) {
  // Transcript evidence + T2 distillations are cohort-internal (consent:
  // cohort-internal, max_surface: cohort). They MUST NOT be committed to this
  // PUBLIC repo. The app sources reviewed evidence from the gated Supabase
  // app_transcript_evidence_cards view at runtime, so the committed surface
  // carries none of that derived layer (matching origin/main's posture).
  assert.ok(
    !surface.transcript_evidence || surface.transcript_evidence.source_artifact_count === 0,
    "committed cohort surface must not embed transcript evidence",
  );
  if (surface.transcript_evidence) {
    assert.equal((surface.transcript_evidence.weekly || []).length, 0);
    assert.equal((surface.transcript_evidence.teams || []).length, 0);
    assert.equal((surface.transcript_evidence.people || []).length, 0);
  }
  assert.equal(
    surface.transcript_distillations?.artifact_count ?? 0,
    0,
    "committed cohort surface must not embed transcript distillations",
  );

  // No evidence-card refs or distillation provenance leak into the committed
  // public bundle. (constellation_cues / session_insights private-vault refs
  // are pre-existing public content shipped on main and are out of scope here.)
  const serialized = JSON.stringify(surface);
  assert.doesNotMatch(serialized, /transcript-evidence:/, "no evidence-card refs in committed surface");
  assert.doesNotMatch(serialized, /"source_artifact_id"/, "no distillation provenance in committed surface");

  // Timelines carry no transcript-evidence anchors in the committed surface.
  assert.equal(timelineEvidence(surface, "team_timeline").length, 0);
  assert.equal(timelineEvidence(surface, "person_timeline").length, 0);
}

function assertPublicWebSurfaceExcludesCohortTranscriptEvidence(surface) {
  assert.equal(surface.surface_visibility, "public-web");
  assert.equal(surface.transcript_evidence?.source_artifact_count, 0);
  assert.equal(surface.transcript_evidence.weekly.length, 0);
  assert.equal(surface.transcript_evidence.teams.length, 0);
  assert.equal(surface.transcript_evidence.people.length, 0);
  assert.equal(surface.cohort_intel.raw_allowed, false);
  assert.equal(surface.cohort_intel.weekly.length, 0);
  assert.equal(surface.cohort_intel.teams.length, 0);
  assert.equal(surface.cohort_intel.people.length, 0);
  assert.match(surface.cohort_intel.context_policy_note, /public Context should use existing articles only/);
  assert.equal(surface.transcript_distillations.artifact_count, 0);
  assert.equal(surface.transcript_distillations.cohort_count, 0);
  assert.equal(surface.transcript_distillations.operator_review_count, 0);
  assert.ok(surface.transcript_distillations.artifacts.every((item) => item.surface === "public"));
  assert.equal(timelineEvidence(surface, "team_timeline").length, 0);
  assert.equal(timelineEvidence(surface, "person_timeline").length, 0);

  const serialized = JSON.stringify(surface);
  assert.doesNotMatch(serialized, /private-vault:/);
  assert.doesNotMatch(serialized, /transcript-evidence:/);
  assert.doesNotMatch(serialized, /drive:\/\//);
  assert.doesNotMatch(serialized, /"source_artifact_id"/);
  assert.doesNotMatch(serialized, /"storage_ref"/);
}

test("committed internal cohort surface omits cohort-internal transcript evidence (sourced from gated Supabase at runtime)", () => {
  assertInternalSurfaceOmitsCommittedTranscriptEvidence(readSurface("apps/os/src/cohort-surface.json"));
});

test("public web cohort surface excludes cohort-only transcript evidence", () => {
  assertPublicWebSurfaceExcludesCohortTranscriptEvidence(readSurface("apps/web/cohort-surface.json"));
});
