// calendar-suggest.mjs — the "suggest an event" door on the calendar page.
//
// Routes a member's event idea to the program admins through the SAME private,
// anon INSERT-only Supabase inbox the Context page writes to
// (public.context_submissions — anon can append one row and read nothing back).
// No new table or migration: source_kind "other" passes the kind CHECK, and
// metadata.submitted_via = "os-calendar-suggest" + metadata.kind =
// "event_suggestion" let the inbox triage route it to the calendar admins.
// The structured fields ride in metadata.event; the body carries the same
// content as readable text so the row makes sense even in a plain inbox view.
//
// Same contract as every anon box: the pure builder is unit-testable and the
// POST always resolves (never throws) with a classified failure reason.

import { postContextSubmission, readContextClientId } from "./context-submit.mjs";

export const SUGGEST_TITLE_MAX = 200;
export const SUGGEST_DETAILS_MAX = 2000;
export const SUGGEST_CONTACT_MAX = 200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;   // native <input type="date">
const TIME_RE = /^\d{2}:\d{2}$/;          // native <input type="time">

function clean(value) {
  return String(value ?? "").trim();
}

// "2026-07-14" → "Tue Jul 14" (UTC, matching the grid's day math). "" on junk.
function friendlyDate(iso) {
  const ms = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Validation + normalization — pure, never throws.
// Returns { ok:true, payload, summary } or { ok:false, error }.
export function buildEventSuggestion(input = {}, { clientId = "" } = {}) {
  const title = clean(input.title).slice(0, SUGGEST_TITLE_MAX);
  if (!title) return { ok: false, error: "give the event a name first." };

  const date = clean(input.date);
  if (date && !DATE_RE.test(date)) return { ok: false, error: "that date doesn't look right." };

  const start = clean(input.start);
  const end = clean(input.end);
  if (start && !TIME_RE.test(start)) return { ok: false, error: "start time doesn't look right." };
  if (end && !TIME_RE.test(end)) return { ok: false, error: "end time doesn't look right." };
  if (end && !start) return { ok: false, error: "an end time needs a start time." };
  if (start && end && end <= start) return { ok: false, error: "the end time is before the start." };

  const category = clean(input.category).slice(0, 40) || null;
  const details = clean(input.details).slice(0, SUGGEST_DETAILS_MAX) || null;
  const contact = clean(input.contact).slice(0, SUGGEST_CONTACT_MAX) || null;

  // One human line for "when": "Tue Jul 14 · 16:00–17:30" | "… · all-day" | "date TBD".
  const day = date ? (friendlyDate(date) || date) : "";
  const when = !day ? "date TBD"
    : start ? `${day} · ${start}${end ? `–${end}` : ""}`
    : `${day} · all-day`;

  const summary = [
    `Event suggestion — ${title}`,
    `When: ${when}`,
    category ? `Type: ${category}` : null,
    details ? `\n${details}` : null,
  ].filter(Boolean).join("\n");

  const payload = {
    org_id: "srfg",
    source_kind: "other",
    title: `Event suggestion: ${title}`.slice(0, 300),
    body: summary,
    contact,
    processing_status: "pending",
    metadata: {
      submitted_via: "os-calendar-suggest",
      kind: "event_suggestion",
      event: {
        title,
        date: date || null,
        start: start || null,
        end: end || null,
        category,
      },
      char_count: summary.length,
    },
  };
  if (clientId) payload.client_id = clientId;
  return { ok: true, payload, summary };
}

// Validate + post in one call — what the calendar's suggest form calls.
// Resolves { ok:true } or { ok:false, reason?, error } (see postContextSubmission).
export async function submitEventSuggestion(input, opts = {}) {
  const built = buildEventSuggestion(input, {
    clientId: opts.clientId != null ? opts.clientId : readContextClientId(opts.storage),
  });
  if (!built.ok) return built;
  return postContextSubmission(built.payload, opts);
}
