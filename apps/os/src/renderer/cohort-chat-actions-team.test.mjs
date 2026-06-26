import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeAction, sanitizeJourney, sanitizeTeamFields,
} from "./cohort-chat-actions.mjs";

const ctx = {
  proposerRecordId: "lsdan",
  proposerClaimHash: "hash123",
  knownRecordIds: new Set(["lsdan", "teesql"]),
  knownTeamIds: new Set(["teesql"]),
};

test("sanitizeJourney bounds numerics, gates enums, keeps text", () => {
  const j = sanitizeJourney({
    stage: 99, evidence_quality: 3, market_upside: 0,
    primary_bottleneck: "GTM", company_type: "Nonsense", confidence: "High",
    problem: "  ICP unclear ", junk: "drop me",
  });
  assert.equal(j.stage, 8); // clamped to max
  assert.equal(j.evidence_quality, 3);
  assert.equal(j.market_upside, 1); // clamped to min
  assert.equal(j.primary_bottleneck, "GTM");
  assert.equal(j.company_type, undefined); // off-enum dropped
  assert.equal(j.confidence, "High");
  assert.equal(j.problem, "ICP unclear");
  assert.equal(j.junk, undefined);
});

test("sanitizeJourney returns null when nothing survives", () => {
  assert.equal(sanitizeJourney({ company_type: "bogus" }), null);
  assert.equal(sanitizeJourney("not an object"), null);
});

test("sanitizeTeamFields whitelists to award-evidence fields only", () => {
  const d = sanitizeTeamFields({
    traction: "3 design partners signed",
    prior_shipping: ["ETHGlobal NY entry", "v0.3 release"],
    success_dimensions: ["productization"],
    now: "this should be dropped (a personal field)",
    journey: { stage: 4 },
  });
  assert.deepEqual(Object.keys(d).sort(), ["journey", "prior_shipping", "success_dimensions", "traction"]);
  assert.equal(d.now, undefined);
  assert.equal(d.journey.stage, 4);
});

test("propose_profile_update on a TEAM subject uses team whitelist + lands pending", () => {
  const a = sanitizeAction({
    action: "propose_profile_update",
    subject_record_id: "teesql",
    fields: { journey: { stage: 5, primary_bottleneck: "GTM" }, traction: "2 pilots", skills: ["drop"] },
    rationale: "pivoted to confidential analytics after design-partner feedback",
  }, ctx);
  assert.equal(a.subject_type, "team");
  assert.equal(a.origin.is_self, false); // a team edit is never a self-edit ⇒ pending review
  assert.equal(a.delta.journey.stage, 5);
  assert.equal(a.delta.traction, "2 pilots");
  assert.equal(a.delta.skills, undefined); // personal field rejected on a team subject
});

test("propose_profile_update on a PERSON subject is unchanged (regression)", () => {
  const a = sanitizeAction({
    action: "propose_profile_update",
    subject_record_id: "lsdan",
    fields: { now: "shipping the distiller", journey: { stage: 5 } },
  }, ctx);
  assert.equal(a.subject_type, "person");
  assert.equal(a.origin.is_self, true); // own profile ⇒ self-edit
  assert.equal(a.delta.now, "shipping the distiller");
  assert.equal(a.delta.journey, undefined); // team field rejected on a person subject
});

test("a team delta with no proposable fields drops the action", () => {
  const a = sanitizeAction({
    action: "propose_profile_update",
    subject_record_id: "teesql",
    fields: { skills: ["x"], now: "y" }, // both personal ⇒ nothing survives the team whitelist
  }, ctx);
  assert.equal(a, null);
});
