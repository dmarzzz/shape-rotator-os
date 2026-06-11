// dial-core — the radial-dial gesture engine, de-Reacted.
//
// Hand-ported from @mikeishiring/radial-dial useRadialDial.ts. The React
// hook keeps useState pairs mirrored into useRef so pointer handlers see
// fresh values between renders; in vanilla JS that bookkeeping collapses
// into one plain state object and a notify() callback.
//
// Hysteresis is the key concept: after any commit or undo, neither fires
// again until the cursor escapes `settleRadius`. This prevents the
// oscillation where the cursor sits inside undo-radius of a freshly
// committed node and flips commit ↔ undo on every pointermove.
//
// All coordinates are stage-local. The caller converts client coords.

import { appendPoint } from "./ink.js";
import {
  ANGULAR_TOLERANCE,
  COMMIT_RATIO,
  FAN_RADIUS_DEEP,
  FAN_RADIUS_ROOT,
  MIN_OUTWARD_PROGRESS,
  OUTWARD_WINDOW,
  SETTLE_RADIUS,
  TAP_COMMIT_RADIUS_FACTOR,
  UNDO_RADIUS,
  angleDiff,
  movementAlignmentStrength,
  movementLaneDominance,
  placeChildren,
  requiredAlignmentStrength,
  requiredLaneDominance,
  velocityCommitFactor,
} from "./geometry.js";

export function createDialController({
  tree,
  flowMode = "corner",
  angularTolerance = ANGULAR_TOLERANCE,
  settleRadius = SETTLE_RADIUS,
  undoRadius = UNDO_RADIUS,
  commitRatio = COMMIT_RATIO,
  fanRadiusFor = (depth) => (depth === 0 ? FAN_RADIUS_ROOT : FAN_RADIUS_DEEP),
  clamp = (p) => p,
  stageFor = null, // () => ({ w, h, margin }) — enables edge-aware arc fitting
  onChange = null,
  onComplete = null,
  onRender = null,
} = {}) {
  const st = {
    phase: "idle", // idle | drawing | committed
    path: [], // [{ node, pos }]
    pointer: null,
    committed: null,
    frozenStrokes: [], // [{ id, points, frozenAt }]
    liveStroke: [],
    armed: true,
    rawHistory: [],
    // After a reverse-drag undo, the popped node's position is held here:
    // it cannot re-commit until the cursor leaves its neighborhood. This
    // is the proximity-grab counterpart of the settle-radius hysteresis —
    // without it, undoing leaves the cursor inside the undone orb's grab
    // zone and commit ↔ undo oscillates.
    undoHold: null,
  };

  function notify() {
    if (onRender) onRender(st);
  }

  function emitChange() {
    if (onChange) onChange({ nodes: st.path.slice(1).map((e) => e.node) });
  }

  /** Fan positions for the active node's children, clamped to the stage. */
  function childPositions(path) {
    const active = path[path.length - 1];
    if (!active?.node.children?.length) return [];
    const grandparent = path.length >= 2 ? path[path.length - 2].pos : null;
    const radius = fanRadiusFor(path.length - 1);
    const stage = stageFor ? stageFor() : null;
    return placeChildren(active.pos, grandparent, active.node.children.length, radius, flowMode, stage)
      .map((p) => clamp(p));
  }

  function visibleChildren() {
    const active = st.path[st.path.length - 1];
    if (!active?.node.children) return [];
    const positions = childPositions(st.path);
    return active.node.children.map((node, i) => ({ node, pos: positions[i] }));
  }

  /** Which child the cursor is currently aimed at, and how confidently. */
  function homed() {
    const active = st.path[st.path.length - 1];
    if (st.phase !== "drawing" || !st.pointer || !active) return null;
    const children = visibleChildren();
    if (children.length === 0) return null;
    const dx = st.pointer.x - active.pos.x;
    const dy = st.pointer.y - active.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist < undoRadius) return null;
    const pa = Math.atan2(dy, dx);
    let bestId = "";
    let bestDelta = Infinity;
    let bestPos = active.pos;
    for (const c of children) {
      const ca = Math.atan2(c.pos.y - active.pos.y, c.pos.x - active.pos.x);
      const d = angleDiff(pa, ca);
      if (d < bestDelta) {
        bestDelta = d;
        bestId = c.node.id;
        bestPos = c.pos;
      }
    }
    if (bestDelta > angularTolerance) return null;
    return { id: bestId, strength: 1 - bestDelta / angularTolerance, targetPos: bestPos };
  }

  // ─── pointer handlers ───────────────────────────────────────────────
  // Every press starts a FRESH gesture from the root, anchored at a fixed
  // origin (the FAB centre) — so the menu always opens in the same place
  // and nothing stale lingers between gestures.

  function pointerDown(press, origin) {
    const rootPos = origin ?? press;
    st.phase = "drawing";
    st.committed = null;
    st.path = [{ node: tree, pos: rootPos }];
    st.pointer = press;
    st.frozenStrokes = [];
    st.liveStroke = [{ ...rootPos, t: performance.now(), v: 0 }];
    st.rawHistory = [press];
    st.armed = true;
    st.undoHold = null;
    notify();
  }

  function pointerMove(p) {
    if (st.phase !== "drawing") return;
    st.pointer = p;
    st.liveStroke = appendPoint(st.liveStroke, p, performance.now());

    // Distance-gated sampling — high-polling mice (1000Hz) deliver
    // sub-pixel deltas per event, which starves the outward-coherence
    // check below (every step reads as "not outward"). Sampling by
    // distance instead of by event makes the gesture rate-invariant.
    const lastRaw = st.rawHistory[st.rawHistory.length - 1];
    if (!lastRaw || Math.hypot(p.x - lastRaw.x, p.y - lastRaw.y) >= 3) {
      st.rawHistory.push(p);
      if (st.rawHistory.length > 12) st.rawHistory.shift();
    }

    const active = st.path[st.path.length - 1];
    if (!active) return;

    const dx = p.x - active.pos.x;
    const dy = p.y - active.pos.y;
    const dist = Math.hypot(dx, dy);

    // Hysteresis: must demonstrably escape settle radius before the next
    // commit/undo transition is allowed to fire.
    if (!st.armed) {
      if (dist > settleRadius) st.armed = true;
      notify();
      return;
    }

    // Reverse-drag undo.
    if (dist < undoRadius && st.path.length > 1) {
      st.undoHold = st.path[st.path.length - 1].pos;
      st.path = st.path.slice(0, -1);
      st.frozenStrokes = st.frozenStrokes.slice(0, -1);
      st.liveStroke = [{ ...p, t: performance.now(), v: 0 }];
      st.rawHistory = [p];
      st.armed = false;
      emitChange();
      notify();
      return;
    }

    // Forward commit.
    const children = active.node.children;
    if (!children?.length) {
      notify();
      return;
    }

    // Release the undo-hold once the cursor has genuinely left the zone.
    if (st.undoHold && Math.hypot(p.x - st.undoHold.x, p.y - st.undoHold.y) > PROXIMITY_COMMIT * 2) {
      st.undoHold = null;
    }

    const commitTo = (idx, positions) => {
      const chosenNode = children[idx];
      const chosenPos = positions[idx];
      // a just-undone node stays uncommittable until the hold lifts
      if (st.undoHold && Math.hypot(chosenPos.x - st.undoHold.x, chosenPos.y - st.undoHold.y) < 12) {
        notify();
        return;
      }
      const now = performance.now();
      const chosenPoint = { ...chosenPos, t: now, v: 0 };
      st.frozenStrokes = [
        ...st.frozenStrokes,
        { id: `${chosenNode.id}-${now}`, points: [...st.liveStroke, chosenPoint], frozenAt: now },
      ];
      st.path = [...st.path, { node: chosenNode, pos: chosenPos }];
      st.liveStroke = [chosenPoint];
      st.rawHistory = [chosenPos];
      st.armed = false;
      emitChange();
      notify();
    };

    // Proximity grab — physically REACHING an option always takes it,
    // mid-drag, no release needed, no gates consulted. The thresholds
    // below are the fast path for decisive flicks; this is the guarantee
    // for deliberate hands.
    {
      const positions = childPositions(st.path);
      let nearIdx = -1;
      let nearDist = Infinity;
      for (let i = 0; i < positions.length; i++) {
        const d = Math.hypot(positions[i].x - p.x, positions[i].y - p.y);
        if (d < nearDist) {
          nearDist = d;
          nearIdx = i;
        }
      }
      if (nearIdx >= 0 && nearDist <= PROXIMITY_COMMIT) {
        commitTo(nearIdx, positions);
        return;
      }
    }

    // Velocity-aware threshold — fast flicks commit sooner (to 72% of the
    // distance), but speed also tightens the required lane alignment, so
    // quick gestures only land when cleanly aimed.
    const recentInk = st.liveStroke.slice(-4);
    const avgV = recentInk.length > 0
      ? recentInk.reduce((s, q) => s + q.v, 0) / recentInk.length
      : 0;
    const commitDistance = fanRadiusFor(st.path.length - 1) * commitRatio;
    const effectiveCommit = commitDistance * velocityCommitFactor(avgV);
    if (dist < effectiveCommit) {
      notify();
      return;
    }

    // Radial coherence — only commit when MOST recent pointer transitions
    // moved outward. Orbiting at constant radius is exploration, not choice.
    const recent = st.rawHistory.slice(-OUTWARD_WINDOW);
    if (recent.length < 3) {
      notify();
      return;
    }
    let outwardSegments = 0;
    for (let i = 1; i < recent.length; i++) {
      const dPrev = Math.hypot(recent[i - 1].x - active.pos.x, recent[i - 1].y - active.pos.y);
      const dCurr = Math.hypot(recent[i].x - active.pos.x, recent[i].y - active.pos.y);
      if (dCurr - dPrev > MIN_OUTWARD_PROGRESS) outwardSegments++;
    }
    const outwardFraction = outwardSegments / (recent.length - 1);
    if (outwardFraction < 0.6) {
      notify();
      return;
    }

    const positions = childPositions(st.path);
    const pa = Math.atan2(dy, dx);
    let bestIdx = -1;
    let bestDelta = Infinity;
    let secondBestDelta = Infinity;
    for (let i = 0; i < positions.length; i++) {
      const a = Math.atan2(positions[i].y - active.pos.y, positions[i].x - active.pos.x);
      const d = angleDiff(pa, a);
      if (d < bestDelta) {
        secondBestDelta = bestDelta;
        bestDelta = d;
        bestIdx = i;
      } else if (d < secondBestDelta) {
        secondBestDelta = d;
      }
    }
    if (bestIdx < 0 || bestDelta >= angularTolerance) {
      notify();
      return;
    }
    const alignmentStrength = movementAlignmentStrength(bestDelta, angularTolerance);
    if (alignmentStrength < requiredAlignmentStrength(avgV)) {
      notify();
      return;
    }
    const laneDominance = movementLaneDominance(bestDelta, secondBestDelta, angularTolerance);
    if (laneDominance < requiredLaneDominance(avgV)) {
      notify();
      return;
    }

    commitTo(bestIdx, positions);
  }

  /** Minimum travel from the active node for a release to count as aim. */
  const RELEASE_COMMIT_MIN = 56;

  /** Cursor within this distance of an option mid-drag grabs it outright. */
  const PROXIMITY_COMMIT = 34;

  function pointerUp(release) {
    st.pointer = null;

    // CASE 0 — release-commit on aim. "Draw, then release" must be
    // literally true: if the cursor is clearly aimed at a child when
    // the button lifts, that child commits — even when the mid-drag
    // gates (velocity, coherence, lane dominance) never fired.
    const active = st.path[st.path.length - 1];
    if (st.phase === "drawing" && active?.node.children?.length) {
      const dx = release.x - active.pos.x;
      const dy = release.y - active.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= RELEASE_COMMIT_MIN) {
        const positions = childPositions(st.path);
        const pa = Math.atan2(dy, dx);
        let bestIdx = -1;
        let bestDelta = Infinity;
        for (let i = 0; i < positions.length; i++) {
          const a = Math.atan2(positions[i].y - active.pos.y, positions[i].x - active.pos.x);
          const d = angleDiff(pa, a);
          if (d < bestDelta) {
            bestDelta = d;
            bestIdx = i;
          }
        }
        if (bestIdx >= 0 && bestDelta < angularTolerance) {
          selectChild(active.node.children[bestIdx], active.pos, positions[bestIdx]);
          st.liveStroke = [];
          if (onComplete) onComplete({ nodes: st.committed || [] });
          return;
        }
      }
    }

    // CASE 1 — drag committed at least one level. Finalize.
    if (st.path.length > 1) {
      st.phase = "committed";
      st.committed = st.path.slice(1).map((e) => e.node);
      st.liveStroke = [];
      if (onComplete) onComplete({ nodes: st.committed });
      notify();
      return;
    }

    // CASE 2 — tap fallback: release landed near a ring-1 option. Narrower
    // than drag commit so open space between siblings isn't a select zone.
    const rootEntry = st.path[0];
    const children = rootEntry?.node.children;
    if (rootEntry && children?.length) {
      const positions = childPositions(st.path);
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < positions.length; i++) {
        const d = Math.hypot(positions[i].x - release.x, positions[i].y - release.y);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestDist < fanRadiusFor(0) * TAP_COMMIT_RADIUS_FACTOR) {
        selectChild(children[bestIdx], rootEntry.pos, positions[bestIdx]);
        if (onComplete) onComplete({ nodes: st.committed || [] });
        return;
      }
    }

    // CASE 3 — no selection (tap on the FAB, or abandoned drag). Reset to
    // idle; the caller decides whether that means "close" or "browse".
    st.path = [];
    st.frozenStrokes = [];
    st.committed = null;
    st.phase = "idle";
    st.armed = true;
    st.liveStroke = [];
    emitChange();
    notify();
  }

  // ─── click navigation (tap-to-browse) ───────────────────────────────

  /**
   * Commit a child WITHOUT a drag — same state result as a drag commit,
   * plus a synthesized bowed stroke so the visual record reads as drawn.
   */
  function selectChild(childNode, fromAnchor, targetPos) {
    let path = st.path;
    const now = performance.now();

    if (path.length === 0) {
      if (!fromAnchor) return;
      path = [{ node: tree, pos: fromAnchor }];
      st.path = path;
    }

    const active = path[path.length - 1];
    const children = active?.node.children;
    if (!children?.length) return;
    const childIdx = children.findIndex((c) => c.id === childNode.id);
    if (childIdx < 0) return;

    const positions = childPositions(path);
    const newPos = targetPos ?? positions[childIdx];

    // Slight perpendicular bow + slow-fast-slow velocity envelope so the
    // synthesized line has the character of a hand stroke.
    const N = 16;
    const pts = [];
    const dx = newPos.x - active.pos.x;
    const dy = newPos.y - active.pos.y;
    const len = Math.hypot(dx, dy);
    const perpX = len > 0 ? -dy / len : 0;
    const perpY = len > 0 ? dx / len : 0;
    const curveFactor = len * 0.06;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const bow = Math.sin(t * Math.PI) * curveFactor;
      pts.push({
        x: active.pos.x + dx * t + perpX * bow,
        y: active.pos.y + dy * t + perpY * bow,
        t: now + i * 8,
        v: 0.1 + Math.sin(t * Math.PI) * 0.45,
      });
    }

    st.path = [...path, { node: childNode, pos: newPos }];
    // `synth` marks click-synthesized strokes so the renderer can draw
    // them in (dashoffset) instead of settling them like a real drag.
    st.frozenStrokes = [...st.frozenStrokes, { id: `${childNode.id}-${now}`, points: pts, frozenAt: now, synth: true }];
    st.committed = st.path.slice(1).map((e) => e.node);
    st.phase = "committed";
    emitChange();
    notify();
  }

  /**
   * Walk back to breadcrumb i (0-based over committed nodes): keeps that
   * node, drops everything after. popToLevel(-1) resets fully.
   */
  function popToLevel(breadcrumbIndex) {
    if (breadcrumbIndex < 0) {
      reset();
      return;
    }
    const next = st.path.slice(0, breadcrumbIndex + 2);
    if (next.length === st.path.length) return;
    st.path = next;
    st.committed = next.length > 1 ? next.slice(1).map((e) => e.node) : null;
    st.frozenStrokes = st.frozenStrokes.slice(0, breadcrumbIndex + 1);
    st.phase = "committed";
    emitChange();
    notify();
  }

  /** Pop exactly one level; at the root this resets to idle. */
  function back() {
    if (st.path.length <= 2) reset();
    else popToLevel(st.path.length - 3);
  }

  function reset() {
    st.path = [];
    st.phase = "idle";
    st.committed = null;
    st.pointer = null;
    st.frozenStrokes = [];
    st.liveStroke = [];
    st.rawHistory = [];
    st.armed = true;
    st.undoHold = null;
    emitChange();
    notify();
  }

  return {
    state: st,
    visibleChildren,
    homed,
    pointerDown,
    pointerMove,
    pointerUp,
    selectChild,
    popToLevel,
    back,
    reset,
  };
}
