#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { loadEnvFile } = require("./lib/env-file.cjs");
const { supabaseServiceRequest } = require("./lib/supabase-rest.cjs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVIEW_DECISIONS = new Set(["approve", "block", "request_changes"]);
const REVIEWABLE_TIERS = new Set(["T1", "T2", "T3"]);
const RAW_LEAK_PATTERNS = [
  /raw-scripts[\\/]/i,
  /local_private[\\/]/i,
  /\b[A-Z]:[\\/]+Users[\\/]/i,
  /\/Users\/[^/\s]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\bSpeaker\s+\d+\s+\d{1,2}:\d{2}\b/i,
];

function usage() {
  return [
    "Usage:",
    "  node scripts/review-transcript-distillation.mjs --env-file .env.calendar.local --artifact-id UUID --tier T2 --decision approve --note \"review note\" --apply",
    "",
    "Safe defaults:",
    "  - Without --apply this is a dry run.",
    "  - T2 approve marks the artifact reviewed for cohort export.",
    "  - T3 approve requires --publish-public and all approval gates approved/not_required.",
    "  - T3 is the only path that can set review_status=published.",
    "",
    "Options:",
    "  --artifact-id UUID       Required derived_artifacts.id",
    "  --tier T1|T2|T3          Required expected tier guard",
    "  --decision value         approve, block, or request_changes; defaults to approve",
    "  --note text              Required reviewer note",
    "  --reviewer-id UUID       Optional auth.users reviewer id for artifact_reviews",
    "  --publish-public         Required for T3 public publication",
    "  --force                  Override duplicate/no-gate refusals; never bypasses blocked/pending T3 gates",
    "  --apply                  Persist changes; otherwise dry run",
  ].join("\n");
}

function readValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
  return argv[index + 1];
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function parseArgs(argv = process.argv.slice(2)) {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) return { help: true };
  const decision = readValue(argv, "--decision") || "approve";
  const opts = {
    envFile: readValue(argv, "--env-file"),
    artifactId: readValue(argv, "--artifact-id"),
    expectedTier: readValue(argv, "--tier"),
    decision,
    note: readValue(argv, "--note") || "",
    reviewerId: readValue(argv, "--reviewer-id"),
    publishPublic: hasFlag(argv, "--publish-public"),
    force: hasFlag(argv, "--force"),
    apply: hasFlag(argv, "--apply"),
  };
  if (!opts.artifactId || !UUID_RE.test(opts.artifactId)) throw new Error("--artifact-id must be a UUID");
  if (!opts.expectedTier || !REVIEWABLE_TIERS.has(opts.expectedTier)) throw new Error("--tier must be T1, T2, or T3");
  if (!REVIEW_DECISIONS.has(opts.decision)) throw new Error("--decision must be approve, block, or request_changes");
  if (!opts.note.trim()) throw new Error("--note is required");
  if (opts.reviewerId && !UUID_RE.test(opts.reviewerId)) throw new Error("--reviewer-id must be a UUID");
  return opts;
}

function assertNoRawLeak(value, label = "artifact") {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  const matched = RAW_LEAK_PATTERNS.find((pattern) => pattern.test(text));
  if (matched) throw new Error(`${label} contains raw/private transcript material matching ${matched}`);
}

function summarizeGateStatus(gates = []) {
  return gates.reduce((acc, gate) => {
    const status = gate?.gate_status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function assertPublicGatesApproved(gates = [], { force = false } = {}) {
  if (!gates.length && !force) {
    throw new Error("T3 publication requires approval gates; none were found");
  }
  const blocked = gates.filter((gate) => gate.gate_status === "blocked");
  if (blocked.length) throw new Error(`T3 publication blocked by ${blocked.length} gate(s)`);
  const pending = gates.filter((gate) => gate.gate_status === "pending");
  if (pending.length) throw new Error(`T3 publication still has ${pending.length} pending gate(s)`);
  const invalid = gates.filter((gate) => !["approved", "not_required"].includes(gate.gate_status));
  if (invalid.length) throw new Error(`T3 publication has ${invalid.length} gate(s) in unsupported status`);
}

function reviewPlan({ artifact, gates = [], expectedTier, decision, publishPublic = false, force = false }) {
  if (!artifact?.id) throw new Error("artifact row is required");
  if (artifact.tier !== expectedTier) {
    throw new Error(`artifact tier is ${artifact.tier || "missing"}, expected ${expectedTier}`);
  }
  if (artifact.tier === "T3" && decision === "approve" && !publishPublic) {
    throw new Error("T3 approval requires --publish-public");
  }
  if (decision === "approve" && ["reviewed", "published"].includes(artifact.review_status) && !force) {
    throw new Error(`artifact already ${artifact.review_status}; use --force to record another review`);
  }
  if (decision === "block" && artifact.review_status === "blocked" && !force) {
    throw new Error("artifact is already blocked; use --force to record another review");
  }

  if (decision === "request_changes") {
    return {
      reviewDecision: "request_changes",
      update: {
        review_status: "needs_review",
        approval_state: artifact.tier === "T3" ? "pending" : "not_required",
      },
      appVisible: false,
    };
  }

  if (decision === "block") {
    return {
      reviewDecision: "block",
      update: {
        review_status: "blocked",
        approval_state: artifact.tier === "T3" ? "blocked" : "not_required",
      },
      appVisible: false,
    };
  }

  assertNoRawLeak({
    content_json: artifact.content_json,
    content_md: artifact.content_md,
  }, `derived artifact ${artifact.id}`);

  if (artifact.tier === "T3") {
    assertPublicGatesApproved(gates, { force });
    return {
      reviewDecision: "approve",
      update: {
        review_status: "published",
        approval_state: "approved",
      },
      appVisible: true,
    };
  }

  return {
    reviewDecision: "approve",
    update: {
      review_status: "reviewed",
      approval_state: "not_required",
    },
    appVisible: artifact.tier === "T2",
  };
}

async function fetchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId, fetchImpl = fetch }) {
  const rows = await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "derived_artifacts",
    query: {
      select: "id,org_id,session_id,source_artifact_id,processing_job_id,artifact_kind,tier,source_transform,review_status,approval_state,confidence,content_json,content_md,created_at",
      org_id: `eq.${orgId}`,
      id: `eq.${artifactId}`,
      limit: 1,
    },
    fetchImpl,
  });
  if (!rows.length) throw new Error(`derived artifact not found: ${artifactId}`);
  return rows[0];
}

async function fetchApprovalGates({ supabaseUrl, serviceRoleKey, orgId, artifactId, fetchImpl = fetch }) {
  return await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "approval_gates",
    query: {
      select: "id,derived_artifact_id,gate_key,gate_status,decided_at,notes,created_at",
      org_id: `eq.${orgId}`,
      derived_artifact_id: `eq.${artifactId}`,
      order: "gate_key.asc",
    },
    fetchImpl,
  });
}

async function patchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId, update, fetchImpl = fetch }) {
  return await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "derived_artifacts",
    method: "PATCH",
    query: {
      org_id: `eq.${orgId}`,
      id: `eq.${artifactId}`,
    },
    body: update,
    fetchImpl,
  });
}

async function insertReview({ supabaseUrl, serviceRoleKey, orgId, artifactId, reviewerId, decision, note, fetchImpl = fetch }) {
  return await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "artifact_reviews",
    method: "POST",
    body: [{
      org_id: orgId,
      derived_artifact_id: artifactId,
      reviewer_id: reviewerId || null,
      decision,
      notes: note,
    }],
    fetchImpl,
  });
}

async function insertAuditLog({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  actorId,
  artifact,
  update,
  decision,
  note,
  gateStatus,
  fetchImpl = fetch,
}) {
  return await supabaseServiceRequest({
    supabaseUrl,
    serviceRoleKey,
    table: "audit_log",
    method: "POST",
    body: [{
      org_id: orgId,
      actor_id: actorId || null,
      action: "review_transcript_distillation",
      object_type: "derived_artifact",
      object_id: artifact.id,
      before_json: {
        review_status: artifact.review_status,
        approval_state: artifact.approval_state,
      },
      after_json: {
        ...update,
        decision,
        note,
        gate_status: gateStatus,
      },
    }],
    fetchImpl,
  });
}

async function reviewTranscriptDistillation({
  supabaseUrl,
  serviceRoleKey,
  orgId,
  artifactId,
  expectedTier,
  decision = "approve",
  note,
  reviewerId,
  publishPublic = false,
  force = false,
  apply = false,
  fetchImpl = fetch,
}) {
  const artifact = await fetchArtifact({ supabaseUrl, serviceRoleKey, orgId, artifactId, fetchImpl });
  const gates = artifact.tier === "T3"
    ? await fetchApprovalGates({ supabaseUrl, serviceRoleKey, orgId, artifactId, fetchImpl })
    : [];
  const plan = reviewPlan({ artifact, gates, expectedTier, decision, publishPublic, force });
  const gateStatus = summarizeGateStatus(gates);
  if (!apply) {
    return { dry_run: true, artifact, gates, plan, gate_status: gateStatus };
  }

  const reviewRows = await insertReview({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    artifactId,
    reviewerId,
    decision: plan.reviewDecision,
    note,
    fetchImpl,
  });
  const artifactRows = await patchArtifact({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    artifactId,
    update: plan.update,
    fetchImpl,
  });
  await insertAuditLog({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    actorId: reviewerId,
    artifact,
    update: plan.update,
    decision: plan.reviewDecision,
    note,
    gateStatus,
    fetchImpl,
  });
  return {
    dry_run: false,
    artifact: artifactRows[0] || { ...artifact, ...plan.update },
    review: reviewRows[0] || null,
    plan,
    gate_status: gateStatus,
  };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return;
  }
  if (opts.envFile) loadEnvFile(opts.envFile, { env: process.env });
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const orgId = process.env.ORG_ID;
  if (!supabaseUrl) throw new Error("SUPABASE_URL is required");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  if (!orgId) throw new Error("ORG_ID is required");

  const result = await reviewTranscriptDistillation({
    supabaseUrl,
    serviceRoleKey,
    orgId,
    artifactId: opts.artifactId,
    expectedTier: opts.expectedTier,
    decision: opts.decision,
    note: opts.note,
    reviewerId: opts.reviewerId,
    publishPublic: opts.publishPublic,
    force: opts.force,
    apply: opts.apply,
  });
  console.log(JSON.stringify({
    ok: true,
    dry_run: result.dry_run,
    artifact_id: opts.artifactId,
    tier: result.artifact?.tier,
    decision: result.plan.reviewDecision,
    update: result.plan.update,
    app_visible: result.plan.appVisible,
    gate_status: result.gate_status,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  assertNoRawLeak,
  assertPublicGatesApproved,
  parseArgs,
  reviewPlan,
  reviewTranscriptDistillation,
  summarizeGateStatus,
};
