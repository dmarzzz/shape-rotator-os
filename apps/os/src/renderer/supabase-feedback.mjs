// supabase-feedback.mjs — the WRITE side of the anonymous OS feedback box.
//
// The membrane page's "OS feedback and idea-box" posts here. This is the app's
// only client-side write to Supabase. It uses the same public anon key as the
// read modules; the security boundary is RLS, not key secrecy. The `anon` role
// holds a column-scoped INSERT grant + an INSERT-only policy on
// public.os_feedback (see supabase/migrations/20260618000000_os_feedback.sql),
// so this key can append ONE feedback row and nothing else — it cannot read
// feedback back, update or delete it, and cannot touch any other table.
//
// Anonymous by construction: only the message text and coarse, non-identifying
// app context (version + platform) are sent. No user, cohort, handle, or token.
// (Supabase edge access logs still see the network IP for any HTTP call, as
// with the read modules — but nothing identifying is written into the row.)

import { readSupabaseConfig } from "./supabase-evidence.mjs";

export const FEEDBACK_MIN_LENGTH = 6; // "more than 5 characters"
export const FEEDBACK_MAX_LENGTH = 2000;

const FEEDBACK_TABLE = "os_feedback";

function feedbackUrl(baseUrl) {
  return `${baseUrl}/rest/v1/${FEEDBACK_TABLE}`;
}

// Trim + bound a small context field; null (not "") when empty so the column
// stays NULL rather than storing an empty string.
function clampField(value, max = 64) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// Submit one anonymous feedback row. Always resolves (never throws): returns
// { ok: true } on success, or { ok: false, error } so the UI can show a quiet
// failure and let the user retry. `Prefer: return=minimal` keeps the response
// body empty and — crucially — means PostgREST does NOT need a SELECT policy to
// satisfy the request (anon is write-only on this table).
export async function submitFeedback(
  { message, appVersion = null, platform = null } = {},
  { storage, fetchImpl, config } = {},
) {
  const doFetch = fetchImpl || globalThis.fetch;
  const text = String(message == null ? "" : message).trim();
  if (text.length < FEEDBACK_MIN_LENGTH) {
    return { ok: false, error: "too_short" };
  }
  const body = {
    message: text.slice(0, FEEDBACK_MAX_LENGTH),
    app_version: clampField(appVersion),
    platform: clampField(platform),
  };
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { ok: false, error: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(feedbackUrl(url), {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${anonKey}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
  if (!res || !res.ok) {
    return { ok: false, error: `HTTP ${res ? res.status : "no response"}` };
  }
  return { ok: true };
}
