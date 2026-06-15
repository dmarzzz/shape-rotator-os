import test from "node:test";
import assert from "node:assert/strict";

import {
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
