import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDistillationManifest,
  exportableByDefault,
  normalizeDerivedArtifact,
} from "./export-transcript-distillations.mjs";

function row(overrides = {}) {
  return {
    id: overrides.id || "artifact-1",
    session_id: overrides.session_id || "session-1",
    source_artifact_id: "source-1",
    processing_job_id: "job-1",
    artifact_kind: overrides.artifact_kind || "readout",
    tier: overrides.tier || "T2",
    source_transform: "paraphrased_distillation",
    review_status: overrides.review_status || "reviewed",
    approval_state: overrides.approval_state || "not_required",
    confidence: 0.7,
    content_json: {
      session_type: "salon",
      distillation: {
        summary: ["Cohort-safe synthesis, not raw transcript text."],
        themes: ["agentic organizations"],
        action_items: ["Create evidence cards before promotion."],
        open_questions: ["Which claims are grounded enough?"],
      },
    },
    content_md: "# Cohort-safe synthesis\n\nNo raw transcript text.",
    created_at: "2026-06-13T00:00:00.000Z",
    ...overrides,
  };
}

test("distillation exporter keeps review-held rows out of app exports by default", () => {
  assert.equal(exportableByDefault(row({ tier: "T2", review_status: "reviewed" })), true);
  assert.equal(exportableByDefault(row({ tier: "T2", review_status: "published" })), true);
  assert.equal(exportableByDefault(row({ tier: "T2", review_status: "needs_review" })), false);
  assert.equal(exportableByDefault(row({ tier: "T3", review_status: "published", approval_state: "approved" })), true);
  assert.equal(exportableByDefault(row({ tier: "T3", review_status: "published", approval_state: "pending" })), false);
});

test("distillation manifest separates cohort and public surfaces", () => {
  const manifest = buildDistillationManifest([
    row({ id: "t2-reviewed", tier: "T2", review_status: "reviewed" }),
    row({ id: "t2-held", tier: "T2", review_status: "needs_review" }),
    row({
      id: "t3-public",
      artifact_kind: "public_candidate",
      tier: "T3",
      review_status: "published",
      approval_state: "approved",
    }),
  ], [
    {
      id: "session-1",
      title: "Agentic Organizations Salon",
      public_title: "Agentic Organizations",
      session_type: "salon",
      starts_at: "2026-06-13T15:30:00Z",
    },
  ], {
    generatedAt: "2026-06-13T00:00:00.000Z",
  });

  assert.equal(manifest.artifact_count, 2);
  assert.equal(manifest.cohort_count, 1);
  assert.equal(manifest.public_count, 1);
  assert.deepEqual(manifest.artifacts.map((item) => item.artifact_id).sort(), ["t2-reviewed", "t3-public"]);
  assert.ok(manifest.artifacts.every((item) => item.provenance.raw_allowed === false));
});

test("distillation export drops artifacts with a retroactively-blocked gate (S5-5 TOCTOU)", () => {
  const rows = [
    row({ id: "t3-published", artifact_kind: "public_candidate", tier: "T3", review_status: "published", approval_state: "approved" }),
    row({ id: "t2-reviewed", tier: "T2", review_status: "reviewed" }),
  ];
  // Both are exportable by their own status, but t3-published had a gate flipped
  // to blocked after the fact — it must not re-export.
  const manifest = buildDistillationManifest(rows, [], {
    generatedAt: "2026-06-13T00:00:00.000Z",
    blockedArtifactIds: new Set(["t3-published"]),
  });
  assert.equal(manifest.artifact_count, 1);
  assert.equal(manifest.public_count, 0);
  assert.deepEqual(manifest.artifacts.map((item) => item.artifact_id), ["t2-reviewed"]);
});

test("distillation exporter rejects raw/private leakage patterns", () => {
  assert.throws(() => normalizeDerivedArtifact(row({
    content_md: "Speaker 1 4:22 copied raw transcript fragment",
  })), /raw or private transcript material/);
  assert.throws(() => normalizeDerivedArtifact(row({
    content_json: {
      distillation: {
        summary: ["see apps/os/src/content/context/raw-scripts/foo.txt"],
      },
    },
  })), /raw or private transcript material/);
});
