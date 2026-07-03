import assert from "node:assert/strict";
import test from "node:test";

import { runTranscriptReceiveSelfTest } from "./transcript-receive-selftest.mjs";

const URL = "https://txjntzwksiluvqcpccpc.supabase.co";
const ANON = "anon-key-for-test";

function jwt(payload = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    iss: "supabase",
    role: "authenticated",
    ref: "txjntzwksiluvqcpccpc",
    iat: 1781370571,
    exp: 2096946571,
    ...payload,
  })).toString("base64url");
  return `${header}.${body}.signature`;
}

function response(rows) {
  return { ok: true, status: 200, json: async () => rows };
}

function fetchImpl(url, opts) {
  const href = String(url);
  if (href.includes("app_my_membership")) {
    assert.match(opts.headers.authorization, /^Bearer /);
    return response([{ email: "member@example.com", record_id: "member-1", record_type: "person", role: "member", status: "approved" }]);
  }
  if (href.includes("public_transcript_evidence_cards")) {
    return response([{ id: "pub-1", title: "public", claim_type: "insight" }]);
  }
  if (href.includes("cohort_app_transcript_evidence_cards")) {
    assert.match(opts.headers.authorization, /^Bearer /);
    return response([{ id: "t2-1", title: "named", claim_type: "insight" }]);
  }
  if (href.includes("cohort_app_transcript_distillations")) {
    assert.match(opts.headers.authorization, /^Bearer /);
    return response([{ id: "dist-1", artifact_kind: "readout", content_json: {}, content_md: "# Readout" }]);
  }
  if (href.includes("cohort_app_cohort_insight_cards")) {
    assert.match(opts.headers.authorization, /^Bearer /);
    return response([{ id: "insight-1", kind: "collaboration_contribution", subject_ids: [] }]);
  }
  throw new Error(`unexpected URL: ${url}`);
}

test("runTranscriptReceiveSelfTest proves T2 through the Google app-session bridge", async () => {
  const token = jwt();
  const result = await runTranscriptReceiveSelfTest({
    api: { auth: { getSession: async () => ({ access_token: token }) } },
    config: { url: URL, anonKey: ANON, cohortKey: "cohort-backup-should-not-be-used" },
    fetchImpl,
    requireGoogleSession: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.public_t3.count, 1);
  assert.equal(result.gated_t2.ready, true);
  assert.equal(result.gated_t2.credential_source, "google_signin_app_session:auth_bridge");
  assert.equal(result.gated_t2.evidence_count, 1);
  assert.equal(result.gated_t2.distillation_count, 1);
  assert.equal(result.gated_t2.cohort_insight_count, 1);
  assert.equal(result.google_membership.ready, true);
  assert.equal(result.google_membership.status, "approved");
  assert.equal(result.google_membership.email_present, true);
  assert.equal(result.google_membership.record_bound, true);
  assert.equal(result.google_signin_app_session.ready, true);
  assert.equal(result.google_signin_app_session.role, "authenticated");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(token.replace(/\./g, "\\.")));
});

test("runTranscriptReceiveSelfTest fails closed when primary Google session is absent", async () => {
  const result = await runTranscriptReceiveSelfTest({
    api: { auth: { getSession: async () => null } },
    config: { url: URL, anonKey: ANON, cohortKey: "cohort-backup-should-not-be-used" },
    fetchImpl,
    requireGoogleSession: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.public_t3.count, 1);
  assert.equal(result.gated_t2.ready, false);
  assert.equal(result.gated_t2.credential_source, "none");
  assert.equal(result.google_membership.ready, false);
  assert.equal(result.google_membership.status, "no_session");
  assert.match(result.errors.join("\n"), /Google sign-in app session is required/);
});
