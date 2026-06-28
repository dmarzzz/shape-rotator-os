import test from "node:test";
import assert from "node:assert/strict";
import {
  SELF_REPORT_AUTORUN_CHOICES_LS_KEY,
  getAutoUpdateChoices,
  rememberAutoUpdateChoices,
} from "./self-report-autoupdate.mjs";

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

test("auto-update choices are absent for missing, corrupt, or empty selections", () => {
  assert.equal(getAutoUpdateChoices("", fakeStorage()), null);
  assert.equal(getAutoUpdateChoices("dmarz", fakeStorage({ [SELF_REPORT_AUTORUN_CHOICES_LS_KEY]: "{bad" })), null);

  const storage = fakeStorage();
  assert.equal(rememberAutoUpdateChoices("dmarz", { useSessions: false, useGithub: false }, { storage }), null);
  assert.equal(getAutoUpdateChoices("dmarz", storage), null);
});

test("auto-update choices persist per record and normalize to booleans", () => {
  const storage = fakeStorage();
  const saved = rememberAutoUpdateChoices(
    "dmarz",
    { useSessions: 1, useGithub: "" },
    { storage, at: "2026-06-28T12:00:00.000Z" },
  );

  assert.deepEqual(saved, {
    useSessions: true,
    useGithub: false,
    updatedAt: "2026-06-28T12:00:00.000Z",
  });
  assert.deepEqual(getAutoUpdateChoices("dmarz", storage), saved);
  assert.equal(getAutoUpdateChoices("ada", storage), null);
});

test("rememberAutoUpdateChoices clears one record without touching another", () => {
  const storage = fakeStorage();
  rememberAutoUpdateChoices("dmarz", { useSessions: true }, { storage, at: "a" });
  rememberAutoUpdateChoices("ada", { useGithub: true }, { storage, at: "b" });

  assert.equal(rememberAutoUpdateChoices("dmarz", null, { storage }), null);
  assert.equal(getAutoUpdateChoices("dmarz", storage), null);
  assert.deepEqual(getAutoUpdateChoices("ada", storage), {
    useSessions: false,
    useGithub: true,
    updatedAt: "b",
  });
});
