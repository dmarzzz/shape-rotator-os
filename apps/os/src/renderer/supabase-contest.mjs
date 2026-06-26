// supabase-contest.mjs — the WRITE side of a member contest of a public insight
// card ("Your Mirror" say/did/shipped). Sibling of supabase-feedback.mjs.
//
// The coordination-OS framework move-5 mechanic ("contest as core surface"): a
// member who disagrees with a public claim about themselves / their team files a
// rebuttal that travels with the claim. This module appends one contest row using
// the same public anon key as the read modules; the security boundary is RLS, not
// key secrecy. The `anon` role holds a column-scoped INSERT grant + an INSERT-only
// policy on public.public_card_contests (see
// supabase/migrations/20260624120000_public_card_contests.sql), so this key can
// append ONE contest row and nothing else — it cannot read contests back, update
// or delete them, and cannot touch any other table.
//
// No auth identity is sent: only the subject the claim is about, the contest kind,
// the member's note / proposed correction, and coarse, non-identifying app context.

import { readSupabaseConfig } from "./supabase-evidence.mjs";

// The four ways a member can push back on a say/did/shipped claim. Kept in sync
// with the CHECK constraint in the migration.
export const CONTEST_KINDS = Object.freeze([
  "stale_declaration",   // "my declared focus is out of date"
  "off_github_work",     // "I shipped it, but not on public GitHub"
  "wrong_attribution",   // "those commits aren't mine (namesake)"
  "context_missing",     // "the number is right but reads wrong without context"
]);
export const CONTEST_NOTE_MAX = 2000;

const CONTEST_TABLE = "public_card_contests";

function contestUrl(baseUrl) {
  return `${baseUrl}/rest/v1/${CONTEST_TABLE}`;
}

// Trim + bound a short field; null (not "") when empty so the column stays NULL.
function clampField(value, max = 64) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// Submit one anonymous contest row. Always resolves (never throws): returns
// { ok: true } on success, or { ok: false, error } so the UI can keep its
// optimistic chip and let the member retry. `Prefer: return=minimal` keeps the
// response body empty so PostgREST does NOT need a SELECT policy to satisfy the
// request (anon is write-only on this table).
export async function submitContest(
  {
    subjectId,
    cardKind = null,
    cardId = null,
    contestKind,
    note = null,
    correction = null,
    appVersion = null,
    platform = null,
  } = {},
  { storage, fetchImpl, config } = {},
) {
  const doFetch = fetchImpl || globalThis.fetch;
  const subject = clampField(subjectId, 128);
  if (!subject) return { ok: false, error: "no_subject" };
  if (!CONTEST_KINDS.includes(contestKind)) return { ok: false, error: "bad_kind" };
  const body = {
    subject_id: subject,
    card_kind: clampField(cardKind, 64),
    card_id: clampField(cardId, 128),
    contest_kind: contestKind,
    member_note: clampField(note, CONTEST_NOTE_MAX),
    declared_correction: clampField(correction, CONTEST_NOTE_MAX),
    app_version: clampField(appVersion),
    platform: clampField(platform),
  };
  const { url, anonKey } = config || readSupabaseConfig(storage);
  if (!url || !anonKey || typeof doFetch !== "function") {
    return { ok: false, error: "unconfigured" };
  }
  let res;
  try {
    res = await doFetch(contestUrl(url), {
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
