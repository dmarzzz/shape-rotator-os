import test from "node:test";
import assert from "node:assert/strict";

import { checkTranscriptReceiveRoute } from "./check-transcript-receive-route.mjs";

const URL = "https://txjntzwksiluvqcpccpc.supabase.co";
const ANON = "anon-key-for-test";

function jwt(payload = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    iss: "supabase",
    role: "cohort_app",
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

test("receive route passes public T3 with no cohort key and reports gated fallback", async () => {
  const calls = [];
  const result = await checkTranscriptReceiveRoute({
    argv: ["--no-live"],
    env: { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON },
    fetchImpl: (url, opts) => {
      calls.push({ url, opts });
      return response([{ id: "pub-1", claim_type: "insight", title: "T3" }]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.release_ready, false);
  assert.equal(result.public_t3.source, "skipped");
  assert.equal(result.gated_t2.status, "fallback");
  assert.equal(calls.length, 0);
});

test("live receive route reads public and gated views with anon apikey plus cohort bearer", async () => {
  const cohortKey = jwt();
  const calls = [];
  const result = await checkTranscriptReceiveRoute({
    argv: [],
    env: {
      SUPABASE_URL: URL,
      SUPABASE_ANON_KEY: ANON,
      SRFG_COHORT_KEY: cohortKey,
    },
    fetchImpl: (url, opts) => {
      calls.push({ url, headers: opts.headers });
      if (String(url).includes("public_transcript_evidence_cards")) {
        return response([{ id: "pub-1", claim_type: "insight", title: "T3" }]);
      }
      if (String(url).includes("cohort_app_transcript_evidence_cards")) {
        return response([{ id: "t2-1", claim_type: "decision", title: "T2" }]);
      }
      if (String(url).includes("cohort_app_transcript_distillations")) {
        return response([{ id: "d1", artifact_kind: "readout", content_json: {}, content_md: "# Readout" }]);
      }
      if (String(url).includes("cohort_app_cohort_insight_cards")) {
        return response([{ id: "i1", kind: "collaboration_contribution", subject_ids: [] }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.gated_t2.ready, true);
  assert.equal(result.app_receive.named_t2_can_receive, true);
  const publicCall = calls.find((call) => String(call.url).includes("public_transcript_evidence_cards"));
  const gatedCalls = calls.filter((call) => String(call.url).includes("cohort_app_"));
  assert.equal(publicCall.headers.apikey, ANON);
  assert.equal(publicCall.headers.authorization, `Bearer ${ANON}`);
  assert.ok(gatedCalls.length >= 3);
  assert.ok(gatedCalls.every((call) => call.headers.apikey === ANON));
  assert.ok(gatedCalls.every((call) => call.headers.authorization === `Bearer ${cohortKey}`));
});

test("live receive route reads gated T2 with Google sign-in app session when no cohort key is configured", async () => {
  const googleSigninAppSession = jwt({ role: "authenticated" });
  const calls = [];
  const result = await checkTranscriptReceiveRoute({
    argv: [],
    env: {
      SUPABASE_URL: URL,
      SUPABASE_ANON_KEY: ANON,
    },
    auth: { getSession: async () => ({ access_token: googleSigninAppSession }) },
    fetchImpl: (url, opts) => {
      calls.push({ url, headers: opts.headers });
      if (String(url).includes("public_transcript_evidence_cards")) {
        return response([{ id: "pub-1", claim_type: "insight", title: "T3" }]);
      }
      if (String(url).includes("cohort_app_transcript_evidence_cards")) {
        return response([{ id: "t2-1", claim_type: "decision", title: "T2" }]);
      }
      if (String(url).includes("cohort_app_transcript_distillations")) {
        return response([{ id: "d1", artifact_kind: "readout", content_json: {}, content_md: "# Readout" }]);
      }
      if (String(url).includes("cohort_app_cohort_insight_cards")) {
        return response([{ id: "i1", kind: "collaboration_contribution", subject_ids: [] }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.release_ready, true);
  assert.equal(result.config.gated_credential_source, "google_signin_app_session:auth_bridge");
  assert.equal(result.gated_t2.ready, true);
  assert.equal(result.app_receive.named_t2_can_receive, true);
  assert.match(result.app_receive.fallback_route, /Google sign-in app session/);
  const publicCall = calls.find((call) => String(call.url).includes("public_transcript_evidence_cards"));
  const gatedCalls = calls.filter((call) => String(call.url).includes("cohort_app_"));
  assert.equal(publicCall.headers.authorization, `Bearer ${ANON}`);
  assert.ok(gatedCalls.length >= 3);
  assert.ok(gatedCalls.every((call) => call.headers.apikey === ANON));
  assert.ok(gatedCalls.every((call) => call.headers.authorization === `Bearer ${googleSigninAppSession}`));
});

test("require-gated fails when only public fallback is available", async () => {
  const result = await checkTranscriptReceiveRoute({
    argv: ["--require-gated"],
    env: { SUPABASE_URL: URL, SUPABASE_ANON_KEY: ANON },
    fetchImpl: () => response([{ id: "pub-1", claim_type: "insight", title: "T3" }]),
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /gated cohort_app receive route is required/);
});

test("receive route result does not leak keys", async () => {
  const cohortKey = jwt();
  const googleSigninAppSession = jwt({ role: "authenticated" });
  const result = await checkTranscriptReceiveRoute({
    argv: ["--skip-audit"],
    env: {
      SUPABASE_URL: URL,
      SUPABASE_ANON_KEY: ANON,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      SRFG_COHORT_KEY: cohortKey,
      SHAPE_SUPABASE_SESSION_TOKEN: googleSigninAppSession,
    },
    fetchImpl: (url) => {
      if (String(url).includes("public_transcript_evidence_cards")) return response([]);
      if (String(url).includes("cohort_app_")) return response([]);
      throw new Error(`unexpected URL: ${url}`);
    },
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(ANON));
  assert.doesNotMatch(serialized, /service-role-secret/);
  assert.doesNotMatch(serialized, new RegExp(cohortKey.replace(/\./g, "\\.")));
  assert.doesNotMatch(serialized, new RegExp(googleSigninAppSession.replace(/\./g, "\\.")));
});
