import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoRawLeak,
  assertPublicGatesApproved,
  parseArgs,
  reviewPlan,
  reviewTranscriptDistillation,
  summarizeGateStatus,
} from "./review-transcript-distillation.mjs";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

function artifact(overrides = {}) {
  return {
    id: ARTIFACT_ID,
    org_id: ORG_ID,
    session_id: "33333333-3333-4333-8333-333333333333",
    artifact_kind: "readout",
    tier: "T2",
    source_transform: "paraphrased_distillation",
    review_status: "needs_review",
    approval_state: "not_required",
    content_json: {
      distillation: {
        summary: ["Cohort-safe synthesis without transcript turns."],
      },
    },
    content_md: "Cohort-safe synthesis without transcript turns.",
    ...overrides,
  };
}

function gate(overrides = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    derived_artifact_id: ARTIFACT_ID,
    gate_key: "speaker_ok",
    gate_status: "approved",
    ...overrides,
  };
}

test("review args require explicit artifact id, expected tier, and note", () => {
  assert.throws(() => parseArgs(["--artifact-id", ARTIFACT_ID, "--note", "reviewed"]), /--tier/);
  assert.throws(() => parseArgs(["--artifact-id", ARTIFACT_ID, "--tier", "T2"]), /--note/);
  assert.equal(parseArgs([
    "--artifact-id", ARTIFACT_ID,
    "--tier", "T2",
    "--note", "reviewed for cohort",
  ]).decision, "approve");
});

test("T2 approve plan marks artifact reviewed and app-visible", () => {
  const plan = reviewPlan({
    artifact: artifact(),
    expectedTier: "T2",
    decision: "approve",
  });
  assert.deepEqual(plan.update, {
    review_status: "reviewed",
    approval_state: "not_required",
  });
  assert.equal(plan.appVisible, true);
});

test("T3 public approval requires explicit publish flag and cleared gates", () => {
  assert.throws(() => reviewPlan({
    artifact: artifact({ tier: "T3", artifact_kind: "public_candidate", approval_state: "pending" }),
    expectedTier: "T3",
    decision: "approve",
    gates: [gate()],
  }), /--publish-public/);

  assert.throws(() => reviewPlan({
    artifact: artifact({ tier: "T3", artifact_kind: "public_candidate", approval_state: "pending" }),
    expectedTier: "T3",
    decision: "approve",
    publishPublic: true,
    gates: [gate({ gate_status: "pending" })],
  }), /pending gate/);

  const plan = reviewPlan({
    artifact: artifact({ tier: "T3", artifact_kind: "public_candidate", approval_state: "pending" }),
    expectedTier: "T3",
    decision: "approve",
    publishPublic: true,
    gates: [gate({ gate_status: "approved" }), gate({ id: "55555555-5555-4555-8555-555555555555", gate_status: "not_required" })],
  });
  assert.deepEqual(plan.update, {
    review_status: "published",
    approval_state: "approved",
  });
  assert.equal(plan.appVisible, true);
});

test("T3 gates cannot be bypassed when blocked or pending", () => {
  assert.throws(() => assertPublicGatesApproved([gate({ gate_status: "blocked" })], { force: true }), /blocked/);
  assert.throws(() => assertPublicGatesApproved([gate({ gate_status: "pending" })], { force: true }), /pending/);
  assert.throws(() => assertPublicGatesApproved([], { force: false }), /none were found/);
  assert.doesNotThrow(() => assertPublicGatesApproved([], { force: true }));
});

test("review plan rejects raw transcript leakage before approval", () => {
  assert.throws(() => assertNoRawLeak("C:\\Users\\micha\\raw-scripts\\standup.txt"), /raw\/private/);
  assert.throws(() => reviewPlan({
    artifact: artifact({ content_md: "Speaker 1 4:22 copied line" }),
    expectedTier: "T2",
    decision: "approve",
  }), /raw\/private/);
});

test("reviewTranscriptDistillation dry-run does not write", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    return Response.json([artifact()]);
  };

  const result = await reviewTranscriptDistillation({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role",
    orgId: ORG_ID,
    artifactId: ARTIFACT_ID,
    expectedTier: "T2",
    decision: "approve",
    note: "reviewed for cohort",
    fetchImpl,
  });

  assert.equal(result.dry_run, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

test("reviewTranscriptDistillation apply inserts review, patches artifact, and writes audit", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const request = {
      url: String(url),
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(request);
    if (request.method === "GET" && request.url.includes("/derived_artifacts")) return Response.json([artifact()]);
    if (request.method === "POST" && request.url.includes("/artifact_reviews")) return Response.json([{ id: "review_1" }]);
    if (request.method === "PATCH" && request.url.includes("/derived_artifacts")) return Response.json([{ ...artifact(), ...request.body }]);
    if (request.method === "POST" && request.url.includes("/audit_log")) return Response.json([{ id: "audit_1" }]);
    return Response.json({ error: "unexpected" }, { status: 404 });
  };

  const result = await reviewTranscriptDistillation({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "service-role",
    orgId: ORG_ID,
    artifactId: ARTIFACT_ID,
    expectedTier: "T2",
    decision: "approve",
    note: "reviewed for cohort",
    apply: true,
    fetchImpl,
  });

  assert.equal(result.dry_run, false);
  assert.equal(calls.map((call) => call.method).join(","), "GET,POST,PATCH,POST");
  assert.equal(calls[1].body[0].decision, "approve");
  assert.equal(calls[2].body.review_status, "reviewed");
  assert.equal(calls[3].body[0].action, "review_transcript_distillation");
});

test("gate summary counts statuses", () => {
  assert.deepEqual(summarizeGateStatus([
    gate({ gate_status: "approved" }),
    gate({ id: "55555555-5555-4555-8555-555555555555", gate_status: "pending" }),
    gate({ id: "66666666-6666-4666-8666-666666666666", gate_status: "approved" }),
  ]), {
    approved: 2,
    pending: 1,
  });
});
