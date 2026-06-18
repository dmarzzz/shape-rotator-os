// context-submit.mjs — the WRITE side of the Context inbox.
//
// The Context page ("transcripts" view) lets a cohort user paste a transcript or
// a note and send it to Supabase for downstream distillation. This is the only
// surface in the app that pushes RAW user text to the server, so it writes to a
// dedicated PRIVATE, insert-only table (public.context_submissions — see
// supabase/migrations/20260618120000_context_submissions.sql), never a public_*
// projection. The anon role can INSERT a pending row and nothing else: it has no
// SELECT grant, so it cannot read back what it (or anyone) submitted. Because of
// that, the POST MUST send `Prefer: return=minimal` — the PostgREST default
// (return=representation) would try to SELECT the new row and fail with 401.
//
// Mirrors the resilient shape of the READ modules (calendar-supabase.mjs,
// supabase-evidence.mjs): the network call always resolves (never throws) so a
// Supabase outage degrades to an inline error, not a crashed view.

import { readSupabaseConfig } from "./supabase-evidence.mjs";

const SUBMISSIONS_TABLE = "context_submissions";
const CLIENT_ID_KEY = "srwk:context_submit_client_id";
const DEFAULT_ORG_ID = "srfg";

// User-facing source kinds. The `value`s MUST stay in lockstep with the
// migration's CHECK list (context_submissions_kind_allowed); the `label`s are
// what the composer select shows. `note` is the default — "other bits of info".
export const CONTEXT_SUBMISSION_KINDS = [
  { value: "transcript", label: "transcript" },
  { value: "note", label: "note" },
  { value: "doc", label: "document text" },
  { value: "link", label: "link / reference" },
  { value: "audio", label: "audio (paste a link)" },
  { value: "video", label: "video (paste a link)" },
  { value: "other", label: "other" },
];
const KIND_VALUES = new Set(CONTEXT_SUBMISSION_KINDS.map((k) => k.value));

// Keep these in lockstep with the table CHECK constraints. The client rejects
// out-of-bounds input before the network so the user gets an instant, friendly
// error instead of an opaque 400 from PostgREST.
export const BODY_MAX = 200000;
export const TITLE_MAX = 300;
export const CONTACT_MAX = 200;

function clean(value) {
  return String(value ?? "").trim();
}

// A stable-ish anonymous client id, so the distillation engine can group a
// user's submissions for dedup / abuse-triage WITHOUT any PII. Persisted in
// localStorage; in non-browser contexts (tests) it just resolves to "" and the
// payload omits the field.
export function readContextClientId(storage = globalThis.localStorage) {
  try {
    let id = storage && storage.getItem ? storage.getItem(CLIENT_ID_KEY) : "";
    if (!id) {
      id = `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      if (storage && storage.setItem) storage.setItem(CLIENT_ID_KEY, id);
    }
    return id || "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Validation + normalization — the single place the feature decides what
// counts as a submittable piece of context. Pure (no network, no DOM) so it is
// fully unit-testable. Returns { ok:true, payload } or { ok:false, error };
// never throws.
//
// The guardrails below are deliberately conservative defaults. They are the
// natural place to tune the feature's behavior — e.g. require a minimum body
// length for `transcript` vs allowing a one-line `note`, or validate that a
// `link` submission actually looks like a URL. Adjust here and the composer +
// server boundary stay consistent (KIND_VALUES + BODY_MAX mirror the migration).
// ---------------------------------------------------------------------------
export function buildContextSubmission(input = {}, { clientId = "", appVersion = "" } = {}) {
  const kind = clean(input.source_kind || input.kind) || "note";
  if (!KIND_VALUES.has(kind)) {
    return { ok: false, error: `unsupported kind: ${kind}` };
  }

  const body = clean(input.body);
  if (!body) {
    return { ok: false, error: "paste a transcript or note first." };
  }
  if (body.length > BODY_MAX) {
    return {
      ok: false,
      error: `too long — ${body.length.toLocaleString()} chars (max ${BODY_MAX.toLocaleString()}). split it into parts.`,
    };
  }

  const title = clean(input.title).slice(0, TITLE_MAX) || null;
  const contact = clean(input.contact).slice(0, CONTACT_MAX) || null;

  const payload = {
    org_id: DEFAULT_ORG_ID,
    source_kind: kind,
    title,
    body,
    contact,
    processing_status: "pending",
    metadata: {
      char_count: body.length,
      submitted_via: "os-context-vault",
    },
  };
  if (clientId) payload.client_id = clientId;
  if (appVersion) payload.app_version = appVersion;
  return { ok: true, payload };
}

export function contextSubmissionsUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/rest/v1/${SUBMISSIONS_TABLE}`;
}

// POST a built payload. INSERT-only: see the header note on Prefer: return=minimal.
// Always resolves; classifies the failure so the UI can phrase it.
export async function postContextSubmission(payload, { config, fetchImpl, storage } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { ok: false, reason: "unconfigured", error: "the context inbox is not configured in this build." };
  }

  let response;
  try {
    response = await doFetch(contextSubmissionsUrl(url), {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, reason: "network", error: err?.message || "network error — try again." };
  }

  if (response.ok) {
    return { ok: true, status: response.status };
  }

  let detail = "";
  try {
    const data = await response.json();
    detail = (data && (data.message || data.error || data.hint)) || "";
  } catch {
    /* non-JSON error body */
  }
  const forbidden = response.status === 401 || response.status === 403;
  return {
    ok: false,
    reason: forbidden ? "forbidden" : "rejected",
    status: response.status,
    error: detail || `submit failed (${response.status}).`,
  };
}

// Validate + post in one call — what the composer calls.
export async function submitContext(input, opts = {}) {
  const built = buildContextSubmission(input, {
    clientId: opts.clientId != null ? opts.clientId : readContextClientId(opts.storage),
    appVersion: opts.appVersion || "",
  });
  if (!built.ok) return built;
  return postContextSubmission(built.payload, opts);
}
