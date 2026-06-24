import test from "node:test";
import assert from "node:assert/strict";

import { submitContest, CONTEST_KINDS } from "../apps/os/src/renderer/supabase-contest.mjs";

const CONFIG = { url: "https://example.supabase.co", anonKey: "anon-key-123" };

// A fetch mock that records the single request and returns an ok response.
function captureFetch(response = { ok: true, status: 201 }) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return response; };
  fn.calls = calls;
  return fn;
}

test("rejects a missing subject without calling fetch", async () => {
  const fetchImpl = captureFetch();
  const res = await submitContest(
    { contestKind: "stale_declaration" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(res, { ok: false, error: "no_subject" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("rejects an unknown contest kind", async () => {
  const fetchImpl = captureFetch();
  const res = await submitContest(
    { subjectId: "elocute", contestKind: "not_a_real_kind" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(res, { ok: false, error: "bad_kind" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("every declared CONTEST_KIND is accepted", async () => {
  for (const kind of CONTEST_KINDS) {
    const fetchImpl = captureFetch();
    const res = await submitContest(
      { subjectId: "elocute", contestKind: kind },
      { config: CONFIG, fetchImpl },
    );
    assert.deepEqual(res, { ok: true }, `kind ${kind} should post`);
    assert.equal(fetchImpl.calls.length, 1);
  }
});

test("returns unconfigured when url/anonKey are missing", async () => {
  const fetchImpl = captureFetch();
  const res = await submitContest(
    { subjectId: "elocute", contestKind: "stale_declaration" },
    { config: { url: "", anonKey: "" }, fetchImpl },
  );
  assert.deepEqual(res, { ok: false, error: "unconfigured" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("posts to the write-only table with the anon headers and a clamped body", async () => {
  const fetchImpl = captureFetch();
  const res = await submitContest(
    {
      subjectId: "  elocute  ",
      cardKind: "say_did_shipped",
      cardId: "card-1",
      contestKind: "off_github_work",
      note: "  shipped in a private repo  ",
      correction: "",
      appVersion: "0.3.11",
      platform: "win32",
    },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(res, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, "https://example.supabase.co/rest/v1/public_card_contests");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, "anon-key-123");
  assert.equal(init.headers.authorization, "Bearer anon-key-123");
  // return=minimal means PostgREST needs no SELECT policy — anon stays write-only.
  assert.equal(init.headers.prefer, "return=minimal");

  const body = JSON.parse(init.body);
  assert.equal(body.subject_id, "elocute");        // trimmed
  assert.equal(body.card_kind, "say_did_shipped");
  assert.equal(body.card_id, "card-1");
  assert.equal(body.contest_kind, "off_github_work");
  assert.equal(body.member_note, "shipped in a private repo"); // trimmed
  assert.equal(body.declared_correction, null);    // empty → null, not ""
  assert.equal(body.app_version, "0.3.11");
  assert.equal(body.platform, "win32");
  // id / created_at are server-assigned and must never be client-sent.
  assert.ok(!("id" in body));
  assert.ok(!("created_at" in body));
});

test("a network throw resolves to a quiet failure (never throws)", async () => {
  const fetchImpl = async () => { throw new Error("offline"); };
  const res = await submitContest(
    { subjectId: "elocute", contestKind: "stale_declaration" },
    { config: CONFIG, fetchImpl },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /offline/);
});

test("a non-ok HTTP response is reported as a failure", async () => {
  const fetchImpl = captureFetch({ ok: false, status: 403 });
  const res = await submitContest(
    { subjectId: "elocute", contestKind: "stale_declaration" },
    { config: CONFIG, fetchImpl },
  );
  assert.deepEqual(res, { ok: false, error: "HTTP 403" });
});
