import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMirrorCommand, resolveMirrorGate, mirrorOfferCopy,
  wasOffered, markOffered, maybeOfferMirror, handToSelfReport,
} from "./cohort-chat-mirror.mjs";

// A tiny in-memory localStorage stand-in.
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), _m: m };
}

test("parseMirrorCommand matches /mirror leading only", () => {
  assert.equal(parseMirrorCommand("/mirror"), true);
  assert.equal(parseMirrorCommand("  /mirror please"), true);
  assert.equal(parseMirrorCommand("/MIRROR"), true);
  assert.equal(parseMirrorCommand("update /mirror"), false);
  assert.equal(parseMirrorCommand("/mirrored"), false);
  assert.equal(parseMirrorCommand(""), false);
});

test("resolveMirrorGate prioritises identity, then CLI readiness", () => {
  assert.equal(resolveMirrorGate({ hasIdentity: false, ready: true }), "no-identity");
  assert.equal(resolveMirrorGate({ hasIdentity: true, ready: false }), "no-cli");
  assert.equal(resolveMirrorGate({ hasIdentity: true, ready: true }), "ready");
});

test("mirrorOfferCopy gives a primary CTA only when ready", () => {
  assert.equal(mirrorOfferCopy("no-identity").primary, null);
  assert.equal(mirrorOfferCopy("no-cli").primary, null);
  const ready = mirrorOfferCopy("ready", { handle: "dmarz" });
  assert.ok(ready.primary);
  assert.match(ready.body, /@dmarz/);
});

test("nag state is per-record and persists", () => {
  const s = fakeStorage();
  assert.equal(wasOffered("dmarz", s), false);
  markOffered("dmarz", s);
  assert.equal(wasOffered("dmarz", s), true);
  assert.equal(wasOffered("ada", s), false); // independent per record
});

test("maybeOfferMirror renders once, then never again", () => {
  const s = fakeStorage();
  let renders = 0;
  let lastGate = null;
  const render = (_copy, gate) => { renders++; lastGate = gate; };
  const opts = { identity: { record_id: "dmarz" }, ready: true, handle: "dmarz", storage: s, render };

  assert.equal(maybeOfferMirror(opts), true);
  assert.equal(renders, 1);
  assert.equal(lastGate, "ready");
  assert.equal(maybeOfferMirror(opts), false); // already offered
  assert.equal(renders, 1);
});

test("maybeOfferMirror no-ops without an identity (nothing to key on)", () => {
  const s = fakeStorage();
  let renders = 0;
  assert.equal(maybeOfferMirror({ identity: null, ready: true, storage: s, render: () => renders++ }), false);
  assert.equal(renders, 0);
});

test("maybeOfferMirror surfaces the no-cli gate when no tool is ready", () => {
  const s = fakeStorage();
  let gate = null;
  maybeOfferMirror({ identity: { record_id: "x" }, ready: false, storage: s, render: (_c, g) => { gate = g; } });
  assert.equal(gate, "no-cli");
});

test("handToSelfReport routes into the seam, or no-ops gracefully", () => {
  let got = null;
  const win = { __srwkOpenSelfReport: (arg) => { got = arg; } };
  assert.equal(handToSelfReport({ record_id: "dmarz", name: "D" }, { win, githubDigest: "g" }), true);
  assert.deepEqual(got, { person: { record_id: "dmarz", name: "D" }, githubDigest: "g" });

  assert.equal(handToSelfReport({ record_id: "dmarz" }, { win: {} }), false); // seam absent
  assert.equal(handToSelfReport(null, { win }), false); // no person
});
