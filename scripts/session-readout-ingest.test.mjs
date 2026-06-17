import test from "node:test";
import assert from "node:assert/strict";
import { COHORT_PUBLISHABLE_KINDS, KINDS, validateReadout } from "./ingest-session-readouts.mjs";

// Guards the kind-enum reconciliation: the engine's distillation-contract.mjs emits
// these kinds; ingest used to accept only {intros,workshop,lecture,salon,hangout,
// standup}, so a kind:"office-hours"/"jam" readout hard-failed ingest. Keep in sync
// with COHORT_PUBLISHABLE_KINDS in the engine repo.
test("ingest KINDS includes the kinds the engine actually emits (no drift)", () => {
  for (const k of ["office-hours", "jam", "demo", "salon", "lecture", "hangout", "standup", "workshop", "intros"]) {
    assert.ok(KINDS.has(k), `ingest must accept engine kind: ${k}`);
  }
  // Restricted kinds must NOT ingest to the cohort lane.
  assert.equal(KINDS.has("interview"), false);
  assert.equal(KINDS.has("planning"), false);
  assert.deepEqual([...KINDS].sort(), [...COHORT_PUBLISHABLE_KINDS].sort());
});

const teams = new Set(["bitrouter", "daedalus"]);
const people = new Set(["andrew-miller"]);
const external = ["Ittai Eyal", "Phala"];

const clean = {
  vault_id: "office-hours-bitrouter-2026-05-27",
  date: "2026-05-27",
  title: "Bitrouter office hours",
  kind: "office-hours",
  consent: "cohort-internal",
  one_liner: "The team sharpened its positioning around one differentiator.",
  thesis: "Pick one differentiator and validate the market.",
  summary: "A review of Bitrouter's positioning and the risks of competing on price and reliability at once.",
  themes: ["positioning an open gateway"],
  insights: [{ text: "Bitrouter should pick one differentiator rather than optimize for price and reliability at once.", subjects: ["bitrouter"], evidence_level: "grounded" }],
  qa: [],
  references: [],
  teams: ["bitrouter"],
  people: [],
};

test("validateReadout accepts a clean structured readout", () => {
  assert.doesNotThrow(() => validateReadout(clean, teams, people, external));
});

test("validateReadout rejects a human name inside the vault_id (the salon-ic3-ittai-eyal class)", () => {
  assert.throws(() => validateReadout({ ...clean, vault_id: "office-hours-andrew-miller-2026-05-27" }, teams, people, external));
  assert.throws(() => validateReadout({ ...clean, vault_id: "salon-ic3-ittai-eyal-2026-06-03" }, teams, people, external));
});

test("validateReadout rejects orphan team tags and off-roster subjects", () => {
  // daedalus tagged but no insight subject references it
  assert.throws(() => validateReadout({ ...clean, teams: ["bitrouter", "daedalus"] }, teams, people, external));
  // insight subject not in roster
  assert.throws(() => validateReadout({ ...clean, teams: [], insights: [{ text: "x claim", subjects: ["ghost-team"], evidence_level: "grounded" }] }, teams, people, external));
});

test("validateReadout rejects financial/legal specifics", () => {
  assert.throws(() => validateReadout({ ...clean, summary: "the team raised $4M last quarter" }, teams, people, external));
  assert.throws(() => validateReadout({ ...clean, summary: "the team faces a possible class action" }, teams, people, external));
});

test("validateReadout still accepts legacy bare-string insights (backward compatible)", () => {
  const legacy = { ...clean, insights: ["Bitrouter should pick one differentiator."], teams: [], people: [] };
  assert.doesNotThrow(() => validateReadout(legacy, teams, people, external));
});
