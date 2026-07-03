import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNamedEntityHintReport,
  evaluateEvidenceCardAudit,
  parseEnvText,
  scanForbiddenKeys,
} from "./audit-supabase-evidence-cards.mjs";

function okResult(table, rows) {
  return { ok: true, status: 200, table, rows, count: rows.length };
}

const baseEvidenceRow = {
  id: "card-1",
  session_id: "session-1",
  source_artifact_id: "source-1",
  claim_type: "insight",
  title: "Reusable coordination pattern",
  claim_text: "Several projects are converging on reusable coordination patterns.",
  summary: "Public-safe synthesis.",
  evidence_level: "aggregate",
  confidence: 0.6,
  attribution_scope: "anonymous_public",
  surface_tier: "T3",
  review_status: "published",
  approval_state: "approved",
  public_anonymous: true,
  public_article_mode: "generalized_no_named_insights",
  content_json: {
    week_start: "2026-06-08",
    themes: ["coordination"],
    raw_allowed: false,
    named_entities_allowed: false,
  },
  created_at: "2026-06-10T00:00:00Z",
};

test("scanForbiddenKeys catches public entity and provenance leaks", () => {
  assert.deepEqual(scanForbiddenKeys({
    themes: ["coordination"],
    teams: ["teleport-router"],
    nested: { storage_ref: "private-transcripts/session.txt" },
  }), ["teams", "nested.storage_ref"]);
});

test("audit fails public rows that expose entity/provenance keys", () => {
  const result = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [baseEvidenceRow]),
    publicResult: okResult("public_transcript_evidence_cards", [{
      ...baseEvidenceRow,
      content_json: {
        ...baseEvidenceRow.content_json,
        teams: ["teleport-router"],
        source_artifact_id: "source-1",
      },
    }]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
  });

  assert.equal(result.status, "fail");
  assert.match(result.privacy.failures.join("\n"), /public row\(s\) expose entity\/provenance keys/);
});

const cleanInsightRow = {
  id: "insight-1",
  kind: "latent_overlap",
  subject_type: "cohort",
  title: "Shared coordination pattern",
  claim_text: "Multiple projects converge on a reusable pattern.",
  summary: "Public-safe synthesis.",
  content_json: { themes: ["coordination"], raw_allowed: false, named_entities_allowed: false },
  created_at: "2026-06-12T00:00:00Z",
};

test("audit accepts a clean public insight view + locked base insight table", () => {
  const result = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [baseEvidenceRow]),
    publicResult: okResult("public_transcript_evidence_cards", [baseEvidenceRow]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
    insightPublicResult: okResult("public_cohort_insight_cards", [cleanInsightRow]),
    anonInsightResult: okResult("cohort_insight_cards", []),
  });
  assert.ok(!result.privacy.failures.join("\n").includes("insight"));
  assert.ok(!result.privacy.failures.join("\n").includes("anon can read cohort_insight_cards"));
});

test("audit warns for private pending T3 candidates without failing public safety", () => {
  const pendingT3 = {
    ...baseEvidenceRow,
    id: "pending-card",
    review_status: "needs_review",
    approval_state: "pending",
  };
  const result = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [pendingT3, baseEvidenceRow]),
    publicResult: okResult("public_transcript_evidence_cards", [baseEvidenceRow]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "warn");
  assert.match(result.privacy.warnings.join("\n"), /private T3 candidate\(s\) are not public-eligible yet/);
  assert.doesNotMatch(result.privacy.failures.join("\n"), /T3 card/);
});

test("strict public-name mode fails known cohort entity hints in public rows", () => {
  const publicRow = {
    id: baseEvidenceRow.id,
    claim_type: baseEvidenceRow.claim_type,
    title: "Quiet Alpha pattern",
    claim_text: "A generalized public-safe claim.",
    summary: "Public-safe synthesis.",
    evidence_level: baseEvidenceRow.evidence_level,
    confidence: baseEvidenceRow.confidence,
    attribution_scope: "anonymous_public",
    content_json: baseEvidenceRow.content_json,
    created_at: baseEvidenceRow.created_at,
  };
  const relaxed = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [baseEvidenceRow]),
    publicResult: okResult("public_transcript_evidence_cards", [publicRow]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
    entityDictionary: [{ kind: "team", value: "quiet alpha" }],
  });
  const strict = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [baseEvidenceRow]),
    publicResult: okResult("public_transcript_evidence_cards", [publicRow]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
    entityDictionary: [{ kind: "team", value: "quiet alpha" }],
    strictPublicNames: true,
  });

  assert.equal(relaxed.ok, true);
  assert.match(relaxed.privacy.warnings.join("\n"), /known cohort entity names/);
  assert.equal(strict.ok, false);
  assert.match(strict.privacy.failures.join("\n"), /known cohort entity names/);
});

test("named-hint report keeps remediation data text-free", () => {
  const report = buildNamedEntityHintReport([{
    id: "public-card-1",
    title: "Quiet Alpha pattern",
    claim_text: "A generalized claim.",
    summary: "Public-safe summary.",
    content_json: { themes: ["coordination"] },
    created_at: "2026-06-12T00:00:00Z",
  }], [{ kind: "team", value: "quiet alpha" }]);
  const serialized = JSON.stringify(report);

  assert.equal(report.rows_with_named_hints, 1);
  assert.equal(report.row_hits[0].id, "public-card-1");
  assert.deepEqual(report.row_hits[0].hits[0].fields, ["title"]);
  assert.ok(report.row_hits[0].hits[0].term_hash);
  assert.doesNotMatch(serialized, /Quiet Alpha/i);
  assert.doesNotMatch(serialized, /generalized claim/i);
  assert.doesNotMatch(serialized, /quiet alpha/i);
});

test("audit fails when an anon public row maps to a base card that fails publication gates", () => {
  const pendingT3 = {
    ...baseEvidenceRow,
    id: "pending-card",
    review_status: "needs_review",
    approval_state: "pending",
  };
  const result = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [pendingT3]),
    publicResult: okResult("public_transcript_evidence_cards", [{
      id: pendingT3.id,
      claim_type: pendingT3.claim_type,
      title: pendingT3.title,
      claim_text: pendingT3.claim_text,
      summary: pendingT3.summary,
      evidence_level: pendingT3.evidence_level,
      confidence: pendingT3.confidence,
      attribution_scope: "anonymous_public",
      content_json: pendingT3.content_json,
      created_at: pendingT3.created_at,
    }]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
  });

  assert.equal(result.status, "fail");
  assert.match(result.privacy.failures.join("\n"), /public row\(s\) map to base cards that fail published\/approved\/anonymous\/no-name gates/);
});

test("audit fails when the public insight view leaks entity keys or anon can read the base insight table", () => {
  const result = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", [baseEvidenceRow]),
    publicResult: okResult("public_transcript_evidence_cards", [baseEvidenceRow]),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
    insightPublicResult: okResult("public_cohort_insight_cards", [{
      ...cleanInsightRow,
      content_json: { ...cleanInsightRow.content_json, teams: ["teleport-router"] },
    }]),
    anonInsightResult: okResult("cohort_insight_cards", [{ id: "leaked" }]),
  });
  assert.equal(result.status, "fail");
  assert.match(result.privacy.failures.join("\n"), /public insight row\(s\) expose entity\/provenance keys/);
  assert.match(result.privacy.failures.join("\n"), /anon can read cohort_insight_cards/);
});

test("audit warns when privacy passes but insight signal is too flat", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    ...baseEvidenceRow,
    id: `card-${index}`,
    session_id: "",
    source_artifact_id: "",
    title: `Public signal ${index}`,
    claim_text: `Unique public-safe claim ${index}`,
  }));
  const result = evaluateEvidenceCardAudit({
    evidenceResult: okResult("evidence_cards", rows),
    publicResult: okResult("public_transcript_evidence_cards", rows.map((row) => ({
      id: row.id,
      claim_type: row.claim_type,
      title: row.title,
      claim_text: row.claim_text,
      summary: row.summary,
      evidence_level: row.evidence_level,
      confidence: row.confidence,
      attribution_scope: "anonymous_public",
      content_json: row.content_json,
      created_at: row.created_at,
    }))),
    anonEvidenceResult: okResult("evidence_cards", []),
    appResult: okResult("app_transcript_evidence_cards", []),
  });

  assert.equal(result.status, "warn");
  assert.equal(result.ok, true);
  assert.match(result.insight.warnings.join("\n"), /provenance links are missing/);
  assert.match(result.insight.warnings.join("\n"), /confidence is uniform/);
  assert.match(result.insight.warnings.join("\n"), /claim_type diversity is low/);
});

test("env parser handles quoted values without logging secrets", () => {
  assert.deepEqual(parseEnvText([
    "# local env",
    "SUPABASE_URL=https://project.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY=\"secret value\"",
  ].join("\n")), {
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "secret value",
  });
});
