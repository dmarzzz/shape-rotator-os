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

import { clampField, postAnonRow } from "./supabase-anon-write.mjs";

export const FEEDBACK_MIN_LENGTH = 6; // "more than 5 characters"
export const FEEDBACK_MAX_LENGTH = 2000;

const FEEDBACK_TABLE = "os_feedback";

// Submit one anonymous feedback row. Always resolves (never throws): returns
// { ok: true } on success, or { ok: false, error } so the UI can show a quiet
// failure and let the user retry. The wire shape (write-only POST, never-throw)
// is shared with the other anon boxes via postAnonRow.
export async function submitFeedback(
  { message, appVersion = null, platform = null } = {},
  opts = {},
) {
  const text = String(message == null ? "" : message).trim();
  if (text.length < FEEDBACK_MIN_LENGTH) {
    return { ok: false, error: "too_short" };
  }
  const body = {
    message: text.slice(0, FEEDBACK_MAX_LENGTH),
    app_version: clampField(appVersion),
    platform: clampField(platform),
  };
  return postAnonRow(FEEDBACK_TABLE, body, opts);
}
