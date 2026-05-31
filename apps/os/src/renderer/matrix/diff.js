// matrix/diff.js — the renderer twin of the Rust `matrix/diff.rs` bridge.
//
// Rust owns the live matrix-rust-sdk objects and streams their reactive
// `eyeball_im::Vector` mutations to us as JSON DiffOp envelopes
// ({ key, seq, diffs }). This module applies those diffs to a plain local
// array — the entire client-side reactivity engine. Pure + framework-free so
// it unit-tests under `node --test`; the op set mirrors DiffOp 1:1.

/**
 * Apply one diff op to `arr` in place. Returns `arr` for chaining.
 * Unknown ops are ignored (forward-compatible).
 * @template T
 * @param {T[]} arr
 * @param {{op: string, [k: string]: any}} d
 * @returns {T[]}
 */
export function applyDiff(arr, d) {
  switch (d.op) {
    case "append":    arr.push(...d.values); break;
    case "clear":     arr.length = 0; break;
    case "pushFront": arr.unshift(d.value); break;
    case "pushBack":  arr.push(d.value); break;
    case "popFront":  arr.shift(); break;
    case "popBack":   arr.pop(); break;
    case "insert":    arr.splice(d.index, 0, d.value); break;
    case "set":       arr[d.index] = d.value; break;
    case "remove":    arr.splice(d.index, 1); break;
    case "truncate":  arr.length = d.length; break;
    case "reset":     arr.length = 0; arr.push(...d.values); break;
    // default: ignore unknown ops (forward-compatible with newer backends)
  }
  return arr;
}

/**
 * Apply a batch of diffs (one envelope's `diffs`) in arrival order.
 * @template T
 * @param {T[]} arr
 * @param {Array<{op: string}>} diffs
 * @returns {T[]}
 */
export function applyDiffs(arr, diffs) {
  for (const d of diffs) applyDiff(arr, d);
  return arr;
}

/**
 * Tracks the per-channel sequence number so the renderer can detect a dropped
 * batch (the SDK's broadcast stream can lag → a `Reset` is coming). Returns
 * `false` when a gap is seen so the caller can re-subscribe to force a reseed.
 * The first batch of a fresh subscription (expected seq 1) always passes.
 */
export class SeqGuard {
  constructor() { this.seq = 0; }
  /** @param {number} incoming @returns {boolean} contiguous? */
  accept(incoming) {
    const contiguous = this.seq === 0 || incoming === this.seq + 1;
    this.seq = incoming;
    return contiguous;
  }
  reset() { this.seq = 0; }
}
