import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_ROUTING_POLICY as WEB_ROUTING_POLICY,
  buildCalendarIngressPayload as buildWebPayload,
  buildEventRequestRow as buildWebEventRequestRow,
  buildGoogleEventPreview as buildWebPreview,
  parseAttendees as parseWebAttendees,
} from "../apps/os/src/vendor/calendar-ingress-client.mjs";
import {
  DEFAULT_ROUTING_POLICY as OS_ROUTING_POLICY,
  buildCalendarIngressPayload as buildOsPayload,
  buildEventRequestRow as buildOsEventRequestRow,
  buildGoogleEventPreview as buildOsPreview,
  parseAttendees as parseOsAttendees,
} from "../apps/os/src/renderer/calendar-ingress.mjs";

const canonicalPolicy = JSON.parse(fs.readFileSync(new URL("../cohort-data/policies/transcript-routing-policy.json", import.meta.url), "utf8"));

const values = {
  title: "Private roadmap critique",
  public_title: "Demo night",
  session_type: "demo_presentation",
  starts_at: "2026-06-16T16:00",
  ends_at: "2026-06-16T17:00",
  timezone: "America/New_York",
  location: "Google Meet",
  attendee_emails: "Guest <Guest@example.com>, guest@example.com; second@example.com",
  public_description: "Safe invite note",
  bot_requested: true,
  request_meet: true,
};

test("web and Electron calendar ingress adapters agree on core payloads", () => {
  const opts = { idFactory: () => "sess_parity" };
  const web = buildWebPayload(values, opts);
  const os = buildOsPayload(values, opts);

  assert.deepEqual(os, web);
  assert.deepEqual(parseOsAttendees(values.attendee_emails), parseWebAttendees(values.attendee_emails));
});

test("web and Electron calendar ingress adapters agree on Google event previews", () => {
  const opts = { idFactory: () => "sess_parity" };
  const webPreview = buildWebPreview(buildWebPayload(values, opts), { botEmail: "bot@example.com" });
  const osPreview = buildOsPreview(buildOsPayload(values, opts), { botEmail: "bot@example.com" });

  assert.deepEqual(osPreview, webPreview);
  assert.equal(webPreview.guestsCanModify, false);
  assert.equal(webPreview.guestsCanInviteOthers, false);
  assert.doesNotMatch(webPreview.description, /Private roadmap critique/);
});

test("web and Electron event requests differ only by surface label", () => {
  const opts = { idFactory: () => "sess_parity" };
  const webRow = buildWebEventRequestRow({ orgId: "org_1", payload: buildWebPayload(values, opts) });
  const osRow = buildOsEventRequestRow({ orgId: "org_1", payload: buildOsPayload(values, opts) });

  const webJson = { ...webRow.request_json, submitted_at: "fixed", surface: "fixed" };
  const osJson = { ...osRow.request_json, submitted_at: "fixed", surface: "fixed" };
  assert.deepEqual(osJson, webJson);
  assert.equal(webRow.request_json.surface, "web");
  assert.equal(osRow.request_json.surface, "electron");
});

// The client policies are the ROUTING-RELEVANT subset for the ingress UI. They
// intentionally carry UI-only hints (e.g. `when`, `event_basis`) and OMIT
// server-only policy detail (drive_vault admins, calendar_matching, etc.) that
// must never ship in the public web bundle. So parity is the routing semantics —
// the exact same normalized subset the `check:calendar-policy` CI gate enforces
// (scripts/check-calendar-ingress-policy-drift.mjs normalizePolicy).
function routingSemantics(policy) {
  return {
    schema_version: policy.schema_version,
    policy_key: policy.policy_key,
    version: policy.version,
    title: policy.title,
    calendar_event_defaults: policy.calendar_event_defaults,
    tiers: policy.tiers,
    session_types: Object.fromEntries(
      Object.entries(policy.session_types || {}).map(([key, value]) => [key, {
        label: value.label,
        description: value.description,
        max_tier: value.max_tier,
        cohort_mode: value.cohort_mode,
        public_allowed: value.public_allowed,
        default_auto_transcript: value.default_auto_transcript,
        required_public_approvals: value.required_public_approvals || [],
        notes: value.notes,
      }]),
    ),
  };
}

test("web and Electron routing policies match the canonical transcript routing semantics", () => {
  assert.deepEqual(routingSemantics(WEB_ROUTING_POLICY), routingSemantics(canonicalPolicy));
  assert.deepEqual(routingSemantics(OS_ROUTING_POLICY), routingSemantics(canonicalPolicy));
});

test("web and Electron payload decisions preserve every canonical session type gate", () => {
  for (const [sessionType, expected] of Object.entries(canonicalPolicy.session_types)) {
    const sessionValues = {
      ...values,
      session_type: sessionType,
      title: `${expected.label} private title`,
      public_title: expected.label,
    };
    const webPayload = buildWebPayload(sessionValues, { idFactory: () => `sess_${sessionType}` });
    const osPayload = buildOsPayload(sessionValues, { idFactory: () => `sess_${sessionType}` });

    assert.deepEqual(osPayload, webPayload);
    assert.equal(webPayload.decision.max_tier, expected.max_tier);
    assert.equal(webPayload.decision.cohort_mode, expected.cohort_mode);
    assert.equal(webPayload.decision.public_allowed, expected.public_allowed);
    assert.equal(webPayload.decision.default_auto_transcript, expected.default_auto_transcript);
    assert.deepEqual(webPayload.decision.required_public_approvals, expected.required_public_approvals);
  }
});
