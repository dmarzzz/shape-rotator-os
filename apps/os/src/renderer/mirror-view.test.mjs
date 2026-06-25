import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMirrorMode, browsableSubjects, isSelfSubject, subjectEyebrow,
  resolveFocus, resolveComparePair, mirrorViewModel,
} from "./mirror-view.mjs";

const TEAMS = [
  { record_id: "loom", name: "Loom" },
  { record_id: "cube", name: "Cube" },
  { record_id: "nocard", name: "No Card" },
];
const withCards = new Set(["loom", "cube"]);
const hasCard = (id) => withCards.has(id);

test("normalizeMirrorMode falls back to self", () => {
  assert.equal(normalizeMirrorMode("compare"), "compare");
  assert.equal(normalizeMirrorMode("bogus"), "self");
  assert.equal(normalizeMirrorMode(undefined), "self");
});

test("browsableSubjects keeps only teams with a card, sorted by name", () => {
  assert.deepEqual(browsableSubjects(TEAMS, hasCard), [
    { teamId: "cube", name: "Cube" },
    { teamId: "loom", name: "Loom" },
  ]);
  assert.deepEqual(browsableSubjects(null, hasCard), []);
});

test("isSelfSubject + subjectEyebrow", () => {
  assert.equal(isSelfSubject("cube", "cube"), true);
  assert.equal(isSelfSubject("cube", "loom"), false);
  assert.equal(isSelfSubject("cube", ""), false);
  assert.equal(subjectEyebrow("cube", "cube", "Cube"), "your mirror");
  assert.equal(subjectEyebrow("loom", "cube", "Loom"), "Loom’s mirror");
});

test("resolveFocus defaults to the first non-self subject, honors a valid request", () => {
  const subjects = browsableSubjects(TEAMS, hasCard);
  // self = cube ⇒ browse opens on the other (loom)
  assert.equal(resolveFocus({ selfTeamId: "cube", subjects }), "loom");
  // a valid explicit focus wins
  assert.equal(resolveFocus({ focusId: "cube", selfTeamId: "cube", subjects }), "cube");
  // an invalid focus falls back
  assert.equal(resolveFocus({ focusId: "ghost", selfTeamId: "loom", subjects }), "cube");
  assert.equal(resolveFocus({ subjects: [] }), null);
});

test("resolveComparePair defaults A=self, B=first other; validates ids", () => {
  const subjects = browsableSubjects(TEAMS, hasCard);
  assert.deepEqual(resolveComparePair({ selfTeamId: "cube", subjects }), { a: "cube", b: "loom" });
  assert.deepEqual(resolveComparePair({ selfTeamId: "cube", aId: "loom", bId: "cube", subjects }),
    { a: "loom", b: "cube" });
  // A defaults to first subject when self has no card
  assert.deepEqual(resolveComparePair({ selfTeamId: "nocard", subjects }), { a: "cube", b: "loom" });
  // B can't equal A
  const r = resolveComparePair({ selfTeamId: "cube", aId: "loom", bId: "loom", subjects });
  assert.equal(r.a, "loom");
  assert.notEqual(r.b, "loom");
});

test("mirrorViewModel assembles per mode", () => {
  const base = { selfTeamId: "cube", teams: TEAMS, hasCard };
  const self = mirrorViewModel({ ...base, mode: "self" });
  assert.equal(self.mode, "self");
  assert.equal(self.subjects.length, 2);
  assert.equal(self.focus, undefined);

  const browse = mirrorViewModel({ ...base, mode: "browse" });
  assert.equal(browse.focus, "loom");

  const compare = mirrorViewModel({ ...base, mode: "compare", compareA: "loom" });
  assert.deepEqual(compare.compare, { a: "loom", b: "cube" });
});
