import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workerSource = fs.readFileSync(new URL("../supabase/functions/process-transcript-jobs/index.ts", import.meta.url), "utf8");

test("transcript cloud worker can run without a local PC dependency", () => {
  assert.match(workerSource, /TRANSCRIPT_WORKER_TOKEN/);
  assert.match(workerSource, /workerAuthorized/);
  assert.match(workerSource, /job_kind:\s*"eq\.artifact_fetch"/);
  assert.match(workerSource, /claim_transcript_processing_jobs/);
  assert.match(workerSource, /apply\s*\?\s*await claimQueuedJobs/);
  assert.match(workerSource, /fetchDriveText/);
  assert.match(workerSource, /GOOGLE_OAUTH_REFRESH_TOKEN/);
  assert.match(workerSource, /https:\/\/oauth2\.googleapis\.com\/token/);
  assert.match(workerSource, /https:\/\/www\.googleapis\.com\/drive\/v3\/files/);
});

test("transcript cloud worker recovers stranded jobs: retry/backoff + stale-lease reclaim (C5-3, C5-4)", () => {
  const retryMigration = fs.readFileSync(
    new URL("../supabase/migrations/202606140001_transcript_worker_retry.sql", import.meta.url),
    "utf8",
  );
  // C5-4: transient failures requeue with bounded backoff instead of failing terminally.
  assert.match(workerSource, /attempts\s*>=\s*maxAttempts/);
  assert.match(workerSource, /processor_status:\s*"queued"/);
  assert.match(workerSource, /due_at:\s*new Date\(Date\.now\(\)\s*\+\s*backoffMinutes/);
  // C5-3: the claim RPC reclaims stale 'running' jobs (a dead worker), counting an attempt.
  assert.match(retryMigration, /add column if not exists attempts/);
  assert.match(retryMigration, /attempts < max_attempts/);
  assert.match(retryMigration, /processor_status = 'running'[\s\S]*started_at < now\(\) - interval '15 minutes'/);
  assert.match(retryMigration, /attempts = job\.attempts \+ 1/);
});

test("transcript cloud worker does not return raw transcript text", () => {
  assert.match(workerSource, /Raw transcript text was processed inside the transcript worker/);
  assert.match(workerSource, /redactedText/);
  assert.match(workerSource, /stored draft contains topic-level synthesis only/);
  assert.match(workerSource, /detectedTopics/);
  assert.match(workerSource, /reviewer_candidates/);
  assert.match(workerSource, /review_prompt/);
  assert.match(workerSource, /derived_artifact_ids/);
  assert.doesNotMatch(workerSource, /summary\s*=\s*sentences\.slice/);
  assert.doesNotMatch(workerSource, /action_items:\s*sentences/);
  assert.doesNotMatch(workerSource, /transcriptText:\s*transcriptText/);
  assert.doesNotMatch(workerSource, /text:\s*fetched\.text/);
  assert.doesNotMatch(workerSource, /transcript_text/);
  assert.match(workerSource, /generated from structured topic-level worker candidate[\s\S]+raw_allowed: false,\s+},/);
});

test("transcript cloud worker separates internal readouts from public candidates", () => {
  assert.match(workerSource, /publicDistillationFor/);
  assert.match(workerSource, /Generalized no-name public candidate/);
  assert.match(workerSource, /publicSurface: true/);
  assert.match(workerSource, /assertTranscriptSurfaceSafe/);
  assert.match(workerSource, /label: "public candidate"/);
  assert.match(workerSource, /label: "public evidence card"/);
});

test("transcript cloud worker preserves review gates before app/public visibility", () => {
  assert.match(workerSource, /review_status:\s*"needs_review"/);
  assert.match(workerSource, /approval_state:\s*"pending"/);
  assert.match(workerSource, /approval_gates/);
  assert.match(workerSource, /evidence_cards/);
  assert.match(workerSource, /evidence_card_ids/);
  assert.match(workerSource, /source_boundary:\s*"derived_only"/);
  assert.match(workerSource, /decision\.required_public_approvals/);
  assert.match(workerSource, /transcript_status:\s*hasReadout \? "distilled" : "source_ready"/);
});

test("transcript cloud worker does not create derived readouts for private-only sessions", () => {
  assert.match(workerSource, /decision\.cohort_mode === "never"/);
  assert.match(workerSource, /return \{ derivedArtifacts: \[\], approvalGates: \[\], evidenceCards: \[\] \}/);
  assert.doesNotMatch(workerSource, /held_private/);
});
