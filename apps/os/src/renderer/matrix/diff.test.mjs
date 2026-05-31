// Tests for matrix/diff.js — run with: node --test apps/os/src/renderer/matrix/
// Pure ESM, no browser globals, no deps. Mirrors the Rust diff.rs test matrix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiff, applyDiffs, SeqGuard } from "./diff.js";

test("append pushes many at the end", () => {
  const a = [1, 2];
  applyDiff(a, { op: "append", values: [3, 4] });
  assert.deepEqual(a, [1, 2, 3, 4]);
});

test("clear empties the array", () => {
  const a = [1, 2, 3];
  applyDiff(a, { op: "clear" });
  assert.deepEqual(a, []);
});

test("pushFront / pushBack", () => {
  const a = [2];
  applyDiff(a, { op: "pushFront", value: 1 });
  applyDiff(a, { op: "pushBack", value: 3 });
  assert.deepEqual(a, [1, 2, 3]);
});

test("popFront / popBack", () => {
  const a = [1, 2, 3];
  applyDiff(a, { op: "popFront" });
  applyDiff(a, { op: "popBack" });
  assert.deepEqual(a, [2]);
});

test("insert at index shifts right", () => {
  const a = ["a", "b", "d"];
  applyDiff(a, { op: "insert", index: 2, value: "c" });
  assert.deepEqual(a, ["a", "b", "c", "d"]);
});

test("set replaces in place", () => {
  const a = ["a", "b", "c"];
  applyDiff(a, { op: "set", index: 1, value: "B" });
  assert.deepEqual(a, ["a", "B", "c"]);
});

test("remove deletes at index", () => {
  const a = ["a", "b", "c"];
  applyDiff(a, { op: "remove", index: 0 });
  assert.deepEqual(a, ["b", "c"]);
});

test("truncate shrinks to length", () => {
  const a = [1, 2, 3, 4, 5];
  applyDiff(a, { op: "truncate", length: 2 });
  assert.deepEqual(a, [1, 2]);
});

test("reset replaces all contents (same array identity)", () => {
  const a = [1, 2, 3];
  const ref = a;
  applyDiff(a, { op: "reset", values: [9, 8] });
  assert.deepEqual(a, [9, 8]);
  assert.equal(a, ref, "must mutate in place so subscribers keep their ref");
});

test("unknown op is ignored (forward-compatible)", () => {
  const a = [1, 2];
  applyDiff(a, { op: "futureThing", value: 3 });
  assert.deepEqual(a, [1, 2]);
});

test("applyDiffs applies a batch in order", () => {
  const a = [];
  applyDiffs(a, [
    { op: "append", values: [1, 2, 3] },
    { op: "pushFront", value: 0 },
    { op: "remove", index: 2 },
  ]);
  assert.deepEqual(a, [0, 1, 3]);
});

test("a Reset round-trips a gappy resync exactly", () => {
  const a = [1, 2, 3, 4];
  applyDiffs(a, [{ op: "reset", values: ["x", "y"] }]);
  assert.deepEqual(a, ["x", "y"]);
});

test("SeqGuard: first batch always contiguous, gaps detected", () => {
  const g = new SeqGuard();
  assert.equal(g.accept(1), true, "first batch (seq 1) passes");
  assert.equal(g.accept(2), true, "contiguous");
  assert.equal(g.accept(3), true, "contiguous");
  assert.equal(g.accept(5), false, "gap (4 dropped) detected");
  // after a gap we typically re-subscribe; the next fresh sub resets:
  g.reset();
  assert.equal(g.accept(1), true, "post-resubscribe first batch passes");
});
