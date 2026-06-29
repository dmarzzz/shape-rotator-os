// private-contact-submit.mjs -- private operational contact capture.
//
// Contact details must not ride through os_profile_updates because that path
// overlays public cohort surfaces. This helper stores member-approved email /
// Telegram details in context_submissions, the existing private INSERT-only
// inbox. The service-role operator/engine can later promote verified rows into
// the private contact directory; anon users never get read-back.

import { postAnonRow } from "./supabase-anon-write.mjs";

const TABLE = "context_submissions";
const ORG_ID = "srfg";
const EMAIL_MAX = 200; // context_submissions.contact CHECK
const ID_MAX = 128;
const TITLE_MAX = 300;
const NOTE_MAX = 800;
const TELEGRAM_MAX = 34; // @ + Telegram's 5-32 char username bound

function clean(value, max) {
  const s = String(value == null ? "" : value).trim();
  return s ? s.slice(0, max) : "";
}

export function normalizePrivateEmail(raw) {
  let s = clean(raw, EMAIL_MAX + 1).replace(/^mailto:/i, "").trim();
  if (!s || s.length > EMAIL_MAX || /[\s<>"'(),;:]/.test(s)) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  return s.toLowerCase();
}

export function normalizePrivateTelegram(raw) {
  let s = clean(raw, TELEGRAM_MAX + 32);
  if (!s) return "";
  s = s.replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, "");
  s = s.replace(/^@+/, "").split(/[/?#]/)[0].trim();
  if (!/^[a-z][a-z0-9_]{4,31}$/i.test(s)) return "";
  const out = `@${s}`;
  return out.length <= TELEGRAM_MAX ? out : "";
}

export function buildPrivateContactSubmission(input = {}) {
  const subjectRecordId = clean(input.subjectRecordId || input.subject_record_id || input.record_id, ID_MAX);
  if (!subjectRecordId) return { ok: false, error: "bad_record_id" };

  const email = normalizePrivateEmail(input.email || input.contact);
  const telegram = normalizePrivateTelegram(input.telegram || input.telegramHandle || input.telegram_handle || input.telegram_username);
  if (!email && !telegram) return { ok: false, error: "bad_contact" };

  const displayName = clean(input.displayName || input.display_name || input.name, 140);
  const note = clean(input.note || input.rationale, NOTE_MAX);
  const proposerRecordId = clean(input.proposerRecordId || input.proposer_record_id, ID_MAX);
  const proposerClaimHash = clean(input.proposerClaimHash || input.proposer_claim_hash, 128);
  const sourceKinds = Array.isArray(input.sourceKinds || input.source_kinds)
    ? (input.sourceKinds || input.source_kinds).map((x) => clean(x, 64)).filter(Boolean).slice(0, 8)
    : [];

  const label = displayName || subjectRecordId;
  const contactParts = [
    email ? "email" : "",
    telegram ? "telegram" : "",
  ].filter(Boolean).join(" + ");
  const payload = {
    org_id: ORG_ID,
    source_kind: "note",
    title: clean(`Private contact for ${label}`, TITLE_MAX) || "Private contact",
    body: [
      `Private ${contactParts || "contact"} details submitted for ${label}.`,
      "Do not publish this in generated cohort surfaces.",
      "Do not use chat/message history to enrich this record.",
      note ? `Note: ${note}` : "",
    ].filter(Boolean).join("\n"),
    contact: email || telegram,
    processing_status: "pending",
    metadata: {
      submitted_via: "cohort-chat-contact",
      contact_kind: "person_private_contact",
      subject_record_id: subjectRecordId,
      display_name: displayName || null,
      private_contact: {
        email: email || null,
        telegram: telegram || null,
      },
      proposer_record_id: proposerRecordId || null,
      proposer_claim_hash: proposerClaimHash || null,
      source_kinds: sourceKinds,
    },
  };
  if (input.appVersion) payload.app_version = clean(input.appVersion, 64);
  if (input.platform) payload.metadata.platform = clean(input.platform, 64);
  return { ok: true, payload };
}

export async function savePrivateContactEmail(input = {}, opts = {}) {
  const built = buildPrivateContactSubmission(input);
  if (!built.ok) return built;
  return postAnonRow(TABLE, built.payload, opts);
}

export const savePrivateContactDetails = savePrivateContactEmail;
