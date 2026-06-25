import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureClaimToken, getClaimToken, getClaimTokenHash, clearClaimToken,
} from "./claim-token.mjs";

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test("ensureClaimToken mints once and is idempotent", async () => {
  const ls = fakeStorage();
  const a = await ensureClaimToken(ls);
  assert.ok(a.token && a.hash, "mints a token + hash");
  assert.match(a.token, /^[0-9a-f]{64}$/, "256-bit hex token");
  const b = await ensureClaimToken(ls);
  assert.deepEqual(b, a, "same token on a second call");
});

test("the hash is a real sha-256 of the token (stable, 64 hex)", async () => {
  const ls = fakeStorage();
  const { token, hash } = await ensureClaimToken(ls);
  // webcrypto is available in Node ≥ 18; verify the stored hash matches.
  const expected = Array.from(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(hash, expected);
});

test("getClaimToken/getClaimTokenHash read back the minted values; clear wipes them", async () => {
  const ls = fakeStorage();
  assert.equal(getClaimTokenHash(ls), "");
  assert.equal(getClaimToken(ls), "");
  const { token, hash } = await ensureClaimToken(ls);
  assert.equal(getClaimToken(ls), token);
  assert.equal(getClaimTokenHash(ls), hash);
  clearClaimToken(ls);
  assert.equal(getClaimToken(ls), "");
  assert.equal(getClaimTokenHash(ls), "");
});

test("a corrupt store reads as empty and re-mints cleanly", async () => {
  const ls = fakeStorage({ "srwk:claim_token_v1": "{not json" });
  assert.equal(getClaimTokenHash(ls), "");
  const rec = await ensureClaimToken(ls);
  assert.ok(rec.token && rec.hash);
});
