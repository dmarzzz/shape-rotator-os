import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPrivateContactSubmission,
  normalizePrivateEmail,
  normalizePrivateTelegram,
  savePrivateContactEmail,
} from "./private-contact-submit.mjs";

const CONFIG = { url: "https://example.supabase.co", anonKey: "anon-123" };

function captureFetch(response = { ok: true, status: 201 }) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return response; };
  fn.calls = calls;
  return fn;
}

test("normalizePrivateEmail accepts one safe email and rejects lists/junk", () => {
  assert.equal(normalizePrivateEmail(" MAILTO:Ada+demo@Example.com "), "ada+demo@example.com");
  assert.equal(normalizePrivateEmail("ada@example"), "");
  assert.equal(normalizePrivateEmail("ada@example.com,other@example.com"), "");
});

test("normalizePrivateTelegram accepts handles/links and rejects loose text", () => {
  assert.equal(normalizePrivateTelegram("@AdaBuilds"), "@AdaBuilds");
  assert.equal(normalizePrivateTelegram("https://t.me/AdaBuilds"), "@AdaBuilds");
  assert.equal(normalizePrivateTelegram("@bad"), "");
  assert.equal(normalizePrivateTelegram("look in my telegram chats"), "");
});

test("buildPrivateContactSubmission creates a private context_submissions payload", () => {
  const r = buildPrivateContactSubmission({
    subjectRecordId: "ada",
    email: "Ada@Example.com",
    telegram: "https://t.me/AdaBuilds",
    displayName: "Ada Lovelace",
    note: "shared after interview",
    proposerRecordId: "dmarz",
    proposerClaimHash: "hash",
    sourceKinds: ["cohort_chat_explicit"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.payload.org_id, "srfg");
  assert.equal(r.payload.source_kind, "note");
  assert.equal(r.payload.contact, "ada@example.com");
  assert.equal(r.payload.processing_status, "pending");
  assert.match(r.payload.body, /Do not publish/);
  assert.match(r.payload.body, /Do not use chat\/message history/);
  assert.deepEqual(r.payload.metadata, {
    submitted_via: "cohort-chat-contact",
    contact_kind: "person_private_contact",
    subject_record_id: "ada",
    display_name: "Ada Lovelace",
    private_contact: {
      email: "ada@example.com",
      telegram: "@AdaBuilds",
    },
    proposer_record_id: "dmarz",
    proposer_claim_hash: "hash",
    source_kinds: ["cohort_chat_explicit"],
  });
});

test("buildPrivateContactSubmission accepts telegram without email", () => {
  const r = buildPrivateContactSubmission({ subjectRecordId: "ada", telegram: "@AdaBuilds" });
  assert.equal(r.ok, true);
  assert.equal(r.payload.contact, "@AdaBuilds");
  assert.deepEqual(r.payload.metadata.private_contact, { email: null, telegram: "@AdaBuilds" });
});

test("buildPrivateContactSubmission rejects missing record or bad contact details", () => {
  assert.deepEqual(buildPrivateContactSubmission({ email: "a@example.com" }), { ok: false, error: "bad_record_id" });
  assert.deepEqual(buildPrivateContactSubmission({ subjectRecordId: "ada", email: "nope" }), { ok: false, error: "bad_contact" });
  assert.deepEqual(buildPrivateContactSubmission({ subjectRecordId: "ada", telegram: "not handle" }), { ok: false, error: "bad_contact" });
});

test("savePrivateContactEmail posts to the insert-only private inbox", async () => {
  const fetchImpl = captureFetch();
  const r = await savePrivateContactEmail(
    { subjectRecordId: "ada", email: "ada@example.com", telegram: "@AdaBuilds", sourceKinds: ["cohort_chat_explicit"] },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://example.supabase.co/rest/v1/context_submissions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, "anon-123");
  assert.equal(init.headers.prefer, "return=minimal");
  const body = JSON.parse(init.body);
  assert.equal(body.contact, "ada@example.com");
  assert.equal(body.metadata.submitted_via, "cohort-chat-contact");
  assert.deepEqual(body.metadata.private_contact, { email: "ada@example.com", telegram: "@AdaBuilds" });
});

test("savePrivateContactEmail short-circuits invalid payloads before fetch", async () => {
  const fetchImpl = captureFetch();
  const r = await savePrivateContactEmail(
    { subjectRecordId: "ada", email: "not-email" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(r, { ok: false, error: "bad_contact" });
  assert.equal(fetchImpl.calls.length, 0);
});
