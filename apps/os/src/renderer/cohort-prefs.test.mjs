import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PREFS, getPrefs, setPrefs, resolvePref, filterByPrefs, shouldEmit,
} from "./cohort-prefs.mjs";

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test("getPrefs returns complete defaults for an empty/corrupt store", () => {
  assert.deepEqual(getPrefs(fakeStorage()), DEFAULT_PREFS);
  assert.deepEqual(getPrefs(fakeStorage({ "srwk:cohort_prefs_v1": "{bad" })), DEFAULT_PREFS);
});

test("getPrefs merges stored knobs over defaults and rejects bad enum values", () => {
  const ls = fakeStorage({
    "srwk:cohort_prefs_v1": JSON.stringify({
      muted_authors: ["p9", 5], interest_tags: ["ai"], emit_policy: "bogus", feed_mode: "global",
    }),
  });
  const p = getPrefs(ls);
  assert.deepEqual(p.muted_authors, ["p9"]);     // non-strings dropped
  assert.deepEqual(p.interest_tags, ["ai"]);
  assert.equal(p.emit_policy, "all");            // bad enum ⇒ default
  assert.equal(p.feed_mode, "global");           // valid enum kept
});

test("resolvePref is prefs ?? default", () => {
  const ls = fakeStorage({ "srwk:cohort_prefs_v1": JSON.stringify({ feed_mode: "global" }) });
  assert.equal(resolvePref("feed_mode", "for_you", ls), "global");
  assert.equal(resolvePref("emit_policy", "all", ls), "all");
});

test("setPrefs persists a merged, validated patch without emitting when emit=false", () => {
  const ls = fakeStorage();
  const next = setPrefs({ muted_event_types: ["prefs", 1], feed_mode: "global" }, { storage: ls, emit: false });
  assert.deepEqual(next.muted_event_types, ["prefs"]);
  assert.equal(next.feed_mode, "global");
  // round-trips through the store
  assert.deepEqual(getPrefs(ls).muted_event_types, ["prefs"]);
});

test("filterByPrefs drops muted authors (actor or subject) and muted types", () => {
  const events = [
    { actor: "a", record_id: "a", event_type: "transcript" },
    { actor: "b", record_id: "b", event_type: "profile_edit" },
    { actor: "c", record_id: "muted_subj", event_type: "contest" },
  ];
  const prefs = { ...DEFAULT_PREFS, muted_authors: ["a", "muted_subj"], muted_event_types: ["profile_edit"] };
  const kept = filterByPrefs(events, prefs);
  assert.equal(kept.length, 0); // a muted, b's type muted, c's subject muted
  const keep = filterByPrefs([{ actor: "z", record_id: "z", event_type: "transcript" }], prefs);
  assert.equal(keep.length, 1);
});

test("shouldEmit follows emit_policy", () => {
  assert.equal(shouldEmit("quiet", { emit_policy: "all" }), true);
  assert.equal(shouldEmit("quiet", { emit_policy: "loud_only" }), false);
  assert.equal(shouldEmit("loud", { emit_policy: "loud_only" }), true);
  assert.equal(shouldEmit("loud", { emit_policy: "none" }), false);
  assert.equal(shouldEmit("loud", {}), true); // missing ⇒ "all"
});
