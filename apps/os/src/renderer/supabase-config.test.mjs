import test from "node:test";
import assert from "node:assert/strict";
import { resolveGatedBearer } from "./supabase-config.mjs";
import { fetchCohortDistillations } from "./supabase-distillations.mjs";

const CFG = { url: "https://x.supabase.co", anonKey: "anon", cohortKey: "" };

test("resolveGatedBearer: cohort key wins outright", async () => {
  const bearer = await resolveGatedBearer(
    { ...CFG, cohortKey: "cohort-jwt" },
    { auth: { getSession: async () => ({ access_token: "session-jwt" }) } },
  );
  assert.equal(bearer, "cohort-jwt");
});

test("resolveGatedBearer: falls back to the signed-in session token", async () => {
  const bearer = await resolveGatedBearer(CFG, {
    auth: { getSession: async () => ({ access_token: "session-jwt" }) },
  });
  assert.equal(bearer, "session-jwt");
});

test("resolveGatedBearer: signed out / no auth bridge → empty (reader no-ops)", async () => {
  assert.equal(await resolveGatedBearer(CFG, { auth: null }), "");
  assert.equal(await resolveGatedBearer(CFG, { auth: { getSession: async () => null } }), "");
  assert.equal(await resolveGatedBearer(CFG, { auth: { getSession: async () => { throw new Error("ipc down"); } } }), "");
});

test("gated distillations read rides the session token when no cohort key", async () => {
  let seenAuth = "";
  const fetchImpl = async (_url, init) => {
    seenAuth = init.headers.Authorization || init.headers.authorization || "";
    return { ok: true, status: 200, json: async () => [] };
  };
  const r = await fetchCohortDistillations({
    config: CFG,
    auth: { getSession: async () => ({ access_token: "session-jwt" }) },
    fetchImpl,
  });
  assert.equal(r.source, "supabase-cohort");
  assert.match(seenAuth, /session-jwt/);
});

test("gated distillations read stays unconfigured when signed out with no key", async () => {
  const r = await fetchCohortDistillations({
    config: CFG,
    auth: null,
    fetchImpl: async () => { throw new Error("should not fetch"); },
  });
  assert.equal(r.source, "unconfigured");
  assert.deepEqual(r.artifacts, []);
});
