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

function assertInternalSurfaceHasTranscriptEvidence(surface) {
  assert.equal(surface.transcript_evidence?.source_artifact_count, 12);
  assert.ok(surface.transcript_evidence.weekly.length >= 1);
  assert.ok(surface.transcript_evidence.teams.length >= 1);
  assert.ok(surface.transcript_evidence.people.length >= 1);
  assert.ok(surface.cohort_intel?.weekly.length >= 1);
  assert.ok(surface.cohort_intel?.card_signals?.teams.length >= 1);
  assert.ok(surface.cohort_intel?.card_signals?.people.length >= 1);
  assert.ok(surface.cohort_intel?.card_signals?.teams.every((signal) => signal.specificity && signal.review_status && signal.source_card_ids?.length >= 1));
  assert.ok(surface.cohort_intel?.card_signals?.people.every((signal) => signal.specificity && signal.review_status && signal.source_card_ids?.length >= 1));
  assert.ok(surface.cohort_intel?.field_notes.length >= 1);
  assert.equal(surface.cohort_intel?.session_notes.length, 12);
  assert.equal(surface.cohort_intel?.signal_inventory?.source_card_count, 12);
  assert.equal(surface.cohort_intel?.signal_inventory?.claim_signal_count, 94);
  assert.equal(surface.cohort_intel?.signal_inventory?.qa_signal_count, 56);
  assert.equal(surface.cohort_intel?.signal_inventory?.total_signal_count, 150);
  assert.equal(surface.cohort_intel?.signal_inventory?.coverage?.sources_without_claims.length, 0);
  assert.equal(surface.cohort_intel?.signal_inventory?.coverage?.sources_without_questions.length, 0);
  assert.ok(surface.cohort_intel?.signal_inventory?.sources.every((source) => {
    return source.signals.length === source.claim_signal_count + source.qa_signal_count;
  }));
  assert.ok(surface.cohort_intel?.field_notes.every((note) => note.markdown && note.sections.length >= 1));
  assert.ok(surface.cohort_intel?.field_notes.every((note) => note.source_card_ids?.length >= 1));
  assert.ok(surface.cohort_intel?.session_notes.every((note) => note.markdown && note.source_card_ids?.length === 1));
  assert.ok(surface.cohort_intel?.data_contract?.quality?.team_signal_count >= 1);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.source_transcript_count, 12);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.total_signal_count, 150);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.claim_signal_count, 94);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.qa_signal_count, 56);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.session_note_count, 12);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.missing_session_note_count, 0);
  assert.equal(surface.cohort_intel.raw_allowed, false);
  assert.match(surface.cohort_intel.context_policy_note, /No transcript readout is public-cleared yet/);
  assert.ok(surface.transcript_distillations?.artifact_count >= 1);
  assert.equal(surface.transcript_distillations.operator_review_count, 0);
  assert.ok(surface.transcript_distillations.artifacts.every((item) => item.surface !== "operator_review"));
  assert.ok(surface.transcript_distillations.artifacts.every((item) => item.provenance?.raw_allowed === false));

  const teamEvidence = timelineEvidence(surface, "team_timeline");
  const personEvidence = timelineEvidence(surface, "person_timeline");
  assert.ok(teamEvidence.length > 0);
  assert.ok(personEvidence.length > 0);
  assert.ok(teamEvidence.every((item) => item.sharing_boundary && !item.href));
  assert.ok(personEvidence.every((item) => item.sharing_boundary && !item.href));
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
  assert.equal(surface.cohort_intel.card_signals.teams.length, 0);
  assert.equal(surface.cohort_intel.card_signals.people.length, 0);
  assert.equal(surface.cohort_intel.field_notes.length, 0);
  assert.equal(surface.cohort_intel.session_notes.length, 0);
  assert.equal(surface.cohort_intel.signal_inventory.total_signal_count, 0);
  assert.equal(surface.cohort_intel.signal_inventory.sources.length, 0);
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

test("internal cohort surface exposes reviewed transcript evidence to app views", () => {
  assertInternalSurfaceHasTranscriptEvidence(readSurface("apps/os/src/cohort-surface.json"));
});

test("public web cohort surface excludes cohort-only transcript evidence", () => {
  assertPublicWebSurfaceExcludesCohortTranscriptEvidence(readSurface("apps/web/cohort-surface.json"));
});
