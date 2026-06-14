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
  const snapshots = surface.cohort_intel?.project_week_snapshots || [];
  const snapshotQuality = surface.cohort_intel?.project_week_snapshot_quality || {};
  const progressRollups = surface.cohort_intel?.project_progress_rollups || [];
  const progressQuality = surface.cohort_intel?.project_progress_rollup_quality || {};
  assert.ok(snapshots.length >= 18);
  assert.equal(snapshotQuality.snapshot_count, snapshots.length);
  assert.equal(snapshotQuality.cohort_only_count, snapshots.length);
  assert.ok(snapshotQuality.project_count >= 12);
  assert.ok(snapshotQuality.weak_snapshot_count >= 1);
  assert.ok((snapshotQuality.drift_status_counts?.partial_drift || 0) + (snapshotQuality.drift_status_counts?.status_conflict || 0) >= 1);
  assert.ok(snapshots.every((snapshot) => {
    return snapshot.project_id
      && snapshot.week_start
      && snapshot.declared_state?.bottleneck_category
      && snapshot.observed_state?.movement
      && snapshot.observed_state?.inferred_bottleneck
      && snapshot.drift?.status
      && snapshot.recommended_intervention
      && snapshot.privacy?.raw_allowed === false;
  }));
  assert.ok(snapshots.every((snapshot) => {
    return ["aligned", "partial_drift", "status_conflict", "insufficient_evidence"].includes(snapshot.drift.status);
  }));
  assert.ok(snapshots
    .filter((snapshot) => snapshot.observed_state.evidence_quality !== "weak")
    .every((snapshot) => snapshot.evidence.project_specific_signal_count >= 1 && snapshot.observed_state.top_observed_claims.length >= 1));
  assert.ok(snapshots
    .filter((snapshot) => snapshot.observed_state.evidence_quality === "weak")
    .every((snapshot) => snapshot.drift.status === "insufficient_evidence"));
  const snapshotNarrativeText = JSON.stringify(snapshots.map((snapshot) => ({
    declared_state: snapshot.declared_state,
    observed_state: {
      movement: snapshot.observed_state.movement,
      inferred_bottleneck: snapshot.observed_state.inferred_bottleneck,
      evidence_summary: snapshot.observed_state.evidence_summary,
      top_observed_claims: snapshot.observed_state.top_observed_claims?.map((claim) => claim.text),
    },
    drift: snapshot.drift,
    recommended_intervention: snapshot.recommended_intervention,
  })));
  assert.doesNotMatch(snapshotNarrativeText, /private-vault:/);
  assert.doesNotMatch(snapshotNarrativeText, /drive:\/\//);
  assert.equal(progressRollups.length, surface.teams.length);
  assert.equal(progressQuality.rollup_count, progressRollups.length);
  assert.equal(progressQuality.cohort_only_count, progressRollups.length);
  assert.ok(progressQuality.no_evidence_count >= 1);
  assert.ok(progressQuality.coverage_gap_count >= 1);
  assert.ok(progressQuality.undated_evidence_project_count >= 1);
  assert.ok(progressRollups.every((rollup) => {
    return rollup.project_id
      && rollup.project_name
      && rollup.current_drift_status
      && rollup.trajectory
      && rollup.intervention_priority
      && rollup.operator_question
      && rollup.recommended_next_check
      && rollup.coverage
      && rollup.privacy?.raw_allowed === false;
  }));
  assert.ok(progressRollups.every((rollup) => ["high", "medium", "low"].includes(rollup.intervention_priority)));
  assert.ok(progressRollups
    .filter((rollup) => rollup.current_drift_status === "no_evidence")
    .every((rollup) => rollup.status_history.length === 0));
  const progressNarrativeText = JSON.stringify(progressRollups.map((rollup) => ({
    trajectory: rollup.trajectory,
    operator_question: rollup.operator_question,
    recommended_next_check: rollup.recommended_next_check,
    status_history: rollup.status_history,
  })));
  assert.doesNotMatch(progressNarrativeText, /private-vault:/);
  assert.doesNotMatch(progressNarrativeText, /drive:\/\//);
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
  assert.equal(surface.cohort_intel?.data_contract?.quality?.project_week_snapshot_count, snapshots.length);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.project_week_project_count, snapshotQuality.project_count);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.project_week_weak_count, snapshotQuality.weak_snapshot_count);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.project_progress_rollup_count, progressRollups.length);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.project_progress_no_evidence_count, progressQuality.no_evidence_count);
  assert.equal(surface.cohort_intel?.data_contract?.quality?.project_progress_undated_count, progressQuality.undated_evidence_project_count);
  assert.ok(surface.cohort_intel?.data_contract?.project_week_snapshot_inputs?.length >= 5);
  assert.ok(surface.cohort_intel?.data_contract?.project_progress_rollup_inputs?.length >= 5);
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
  assert.equal(surface.cohort_intel.project_week_snapshots.length, 0);
  assert.equal(surface.cohort_intel.project_week_snapshot_quality.snapshot_count, 0);
  assert.equal(surface.cohort_intel.project_progress_rollups.length, 0);
  assert.equal(surface.cohort_intel.project_progress_rollup_quality.rollup_count, 0);
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
