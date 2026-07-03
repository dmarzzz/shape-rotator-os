import {
  fetchCohortEvidenceCards,
  fetchCohortInsightCards,
  fetchPublicEvidenceCards,
  readSupabaseConfig,
} from "./supabase-evidence.mjs";
import { fetchCohortDistillations } from "./supabase-distillations.mjs";
import { fetchAnon } from "./supabase-anon-write.mjs";

const APP_MEMBERSHIP_PATH = "app_my_membership?select=email,record_id,record_type,role,status,display_name,approved_at&limit=1";

function decodeJwtPayload(jwt) {
  try {
    const payload = String(jwt || "").split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) || null;
  } catch {
    return null;
  }
}

function summarizeSession(session, now = new Date()) {
  const token = String(session?.access_token || "").trim();
  const result = {
    status: token ? "invalid" : "missing",
    ready: false,
    source: "auth_bridge",
    token_present: Boolean(token),
    jwt_shape: /^[^.]+\.[^.]+\.[^.]+$/.test(token),
    role: null,
    expires_at: null,
    seconds_until_expiry: null,
    errors: [],
    warnings: [],
  };
  if (!token) {
    result.errors.push("no Google sign-in app session available from window.api.auth.getSession()");
    return result;
  }
  if (!result.jwt_shape) {
    result.errors.push("Google sign-in app session token is not JWT-shaped");
    return result;
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    result.errors.push("Google sign-in app session token payload cannot be decoded");
    return result;
  }
  result.role = typeof payload.role === "string" ? payload.role : null;
  if (result.role && result.role !== "authenticated") {
    result.errors.push(`expected role=authenticated, got ${result.role}`);
  } else if (!result.role) {
    result.warnings.push("Google sign-in app session token has no role claim");
  }
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp)) {
    result.errors.push("Google sign-in app session token is missing exp");
  } else {
    result.expires_at = new Date(exp * 1000).toISOString();
    result.seconds_until_expiry = Math.floor((exp * 1000 - now.getTime()) / 1000);
    if (result.seconds_until_expiry <= 30) {
      result.errors.push("Google sign-in app session token is expired or too close to expiry");
    }
  }
  if (!result.errors.length) {
    result.status = "ready";
    result.ready = true;
  }
  return result;
}

function summarizeRead(result = {}, rowsKey) {
  const rows = result?.[rowsKey];
  return {
    ok: result.source === "supabase" || result.source === "supabase-cohort",
    source: result.source || "error",
    count: Array.isArray(rows) ? rows.length : 0,
    error: result.error ? String(result.error) : null,
  };
}

async function readGatedTier({ config, auth, fetchImpl }) {
  const opts = { config, auth, fetchImpl };
  const [evidence, distillations, insights] = await Promise.all([
    fetchCohortEvidenceCards(opts),
    fetchCohortDistillations(opts),
    fetchCohortInsightCards(opts),
  ]);
  const summary = {
    evidence: summarizeRead(evidence, "cards"),
    distillations: summarizeRead(distillations, "artifacts"),
    cohort_insights: summarizeRead(insights, "cards"),
  };
  summary.ready = summary.evidence.ok && summary.distillations.ok && summary.cohort_insights.ok;
  summary.status = summary.ready ? "ready" : "fallback";
  return summary;
}

function membershipResult(overrides = {}) {
  return {
    ok: false,
    ready: false,
    status: "missing",
    source: "skipped",
    row_count: 0,
    email_present: false,
    record_bound: false,
    record_type: null,
    role: null,
    error: null,
    ...overrides,
  };
}

function summarizeMembershipRead(result = {}) {
  if (result.source !== "supabase") {
    return membershipResult({
      status: result.error === "HTTP 404" ? "not_deployed" : "error",
      source: result.source || "error",
      error: result.error ? String(result.error) : null,
    });
  }
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const row = rows[0];
  if (!row) return membershipResult({ status: "unapproved", source: "supabase", row_count: 0 });
  const rawStatus = String(row.status || "unknown");
  const recordBound = Boolean(row.record_id);
  return membershipResult({
    ok: true,
    ready: rawStatus === "approved" && recordBound,
    status: rawStatus === "approved" && !recordBound ? "needs_binding" : rawStatus,
    source: "supabase",
    row_count: rows.length,
    email_present: Boolean(row.email),
    record_bound: recordBound,
    record_type: row.record_type ? String(row.record_type) : null,
    role: row.role ? String(row.role) : null,
  });
}

export async function runTranscriptReceiveSelfTest({
  api = globalThis.api,
  config = null,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  requireGoogleSession = true,
} = {}) {
  const cfg = config || readSupabaseConfig(globalThis.localStorage);
  const authApi = api?.auth;
  let session = null;
  const errors = [];
  const warnings = [];

  try {
    session = authApi?.getSession ? await authApi.getSession() : null;
  } catch (error) {
    errors.push(`auth bridge getSession failed: ${error?.message || String(error)}`);
  }

  const googleSession = summarizeSession(session, now);
  warnings.push(...googleSession.warnings);
  const auth = {
    getSession: async () => (session?.access_token ? { access_token: session.access_token } : null),
  };
  const primaryConfig = { ...cfg, cohortKey: "" };

  const publicResult = await fetchPublicEvidenceCards({ config: cfg, fetchImpl });
  const publicT3 = summarizeRead(publicResult, "cards");
  if (!publicT3.ok) errors.push(`public T3 reader failed: ${publicT3.error || publicT3.source}`);

  const gated = await readGatedTier({ config: primaryConfig, auth, fetchImpl });
  const membership = session?.access_token
    ? summarizeMembershipRead(await fetchAnon(APP_MEMBERSHIP_PATH, { config: cfg, fetchImpl, bearer: session.access_token }))
    : membershipResult({ status: "no_session", source: "auth_bridge" });
  if (requireGoogleSession && !googleSession.ready) {
    errors.push("Google sign-in app session is required but not ready");
  }
  if (requireGoogleSession && !gated.ready) {
    errors.push("Google sign-in app session gated T2 read is required but not ready");
  }
  if (requireGoogleSession && !membership.ready) {
    errors.push("Google sign-in app session must resolve to an approved, bound Shape OS member");
  }

  const ok = errors.length === 0 && publicT3.ok && (!requireGoogleSession || (gated.ready && membership.ready));
  return {
    ok,
    status: errors.length ? "fail" : ok ? "pass" : "warn",
    generated_at: now.toISOString(),
    config: {
      supabase_url_present: Boolean(cfg.url),
      anon_key_present: Boolean(cfg.anonKey),
      runtime_cohort_key_present: Boolean(cfg.cohortKey),
      require_google_session: Boolean(requireGoogleSession),
    },
    public_t3: publicT3,
    google_signin_app_session: googleSession,
    google_membership: membership,
    gated_t2: {
      required: Boolean(requireGoogleSession),
      ready: gated.ready,
      status: gated.status,
      credential_source: googleSession.ready ? "google_signin_app_session:auth_bridge" : "none",
      evidence_count: gated.evidence.count,
      distillation_count: gated.distillations.count,
      cohort_insight_count: gated.cohort_insights.count,
    },
    app_receive: {
      public_can_receive_generalized_t3: publicT3.ok,
      named_t2_can_receive: gated.ready,
      transcript_tab_can_receive_distillations: gated.distillations.ok,
    },
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}
