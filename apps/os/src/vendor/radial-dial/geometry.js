// Geometry — the quick dial's physical dimensions and motion grammar.
//
// Hand-ported from @mikeishiring/radial-dial (geometry.ts + the pure
// helpers of useRadialDial.ts), scaled for a corner-anchored fan. Pure
// math only — no DOM, no framework. If a number is named here, every
// quick-dial module imports it from here.
//
// Scaling rationale: the package tunes for a full-screen centered dial
// (FAN_RADIUS 224 / COMMIT_DISTANCE 174). The corner stage is smaller,
// so radii shrink — but the COMMIT/FAN ratio of 0.8 is preserved. That
// ratio is the "magnetic grab" window; it is the feel constant.

// ─── physical dimensions ─────────────────────────────────────────────

/** Option bubble diameter (the destinations — largest size). */
export const OPTION_DIAMETER = 80;

/** Settled past-path marker diameter (quiet trail dots). */
export const NODE_MARKER_DIAMETER = 12;

/** Ring-1 fan radius from the FAB corner anchor. */
export const FAN_RADIUS_ROOT = 164;

/** Deeper-ring fan radius — slightly wider so six options clear each other. */
export const FAN_RADIUS_DEEP = 184;

/** Commit fires at this fraction of the fan radius (the magnetic window). */
export const COMMIT_RATIO = 0.8;

/** Hysteresis re-arm radius — must escape this after a commit/undo. */
export const SETTLE_RADIUS = 96;

/** Drag back inside this radius of the active node to pop one level. */
export const UNDO_RADIUS = 40;

/** Half-cone (radians) within which a child counts as "homed". */
export const ANGULAR_TOLERANCE = Math.PI / 4.5;

/** Tap fallback commit radius, as a fraction of fan radius. */
export const TAP_COMMIT_RADIUS_FACTOR = 0.34;

// ─── ink geometry ─────────────────────────────────────────────────────

export const INK_BASE_WIDTH = 1.6;
export const SETTLE_DURATION_MS = 340;

// ─── motion grammar — the three sacred easings (CSS strings) ─────────
// Pick by intent: arriving-alive → OVERSHOOT; settling → SMOOTH_OUT;
// shooting-then-coasting → EXPO_OUT. Entrances slower than exits.

export const OVERSHOOT = "cubic-bezier(0.34, 1.56, 0.64, 1)";
export const SMOOTH_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
export const EXPO_OUT = "cubic-bezier(0.19, 1, 0.22, 1)";

/** Per-bubble bloom stagger (ms) — multiplied by sibling index. */
export const BLOOM_STAGGER_MS = 42;

// ─── commit decision math (ported verbatim from useRadialDial.ts) ────

const MIN_COMMIT_DISTANCE_FACTOR = 0.72;
const VELOCITY_COMMIT_START = 0.22;
const VELOCITY_COMMIT_FULL = 1.05;
const SLOW_ALIGNMENT_STRENGTH = 0.38;
const FAST_ALIGNMENT_STRENGTH = 0.68;
const SLOW_LANE_DOMINANCE = 0.34;
const FAST_LANE_DOMINANCE = 0.48;

/** Minimum net outward speed (px/point) below which the cursor is orbiting. */
export const MIN_OUTWARD_PROGRESS = 1.6;
/** Recent-point window for the outward-progress estimate. */
export const OUTWARD_WINDOW = 5;

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Fast flicks commit sooner — but only down to 72% of the distance. */
export function velocityCommitFactor(avgVelocity) {
  const t = clamp01((avgVelocity - VELOCITY_COMMIT_START) / (VELOCITY_COMMIT_FULL - VELOCITY_COMMIT_START));
  return 1 - t * (1 - MIN_COMMIT_DISTANCE_FACTOR);
}

export function movementAlignmentStrength(bestDelta, angularTolerance) {
  if (angularTolerance <= 0) return 0;
  return clamp01(1 - bestDelta / angularTolerance);
}

/** Fast users must be aimed more cleanly; slow users get more slack. */
export function requiredAlignmentStrength(avgVelocity) {
  const t = clamp01((avgVelocity - VELOCITY_COMMIT_START) / (VELOCITY_COMMIT_FULL - VELOCITY_COMMIT_START));
  return SLOW_ALIGNMENT_STRENGTH + t * (FAST_ALIGNMENT_STRENGTH - SLOW_ALIGNMENT_STRENGTH);
}

export function movementLaneDominance(bestDelta, secondBestDelta, angularTolerance) {
  if (angularTolerance <= 0) return 0;
  if (!Number.isFinite(secondBestDelta)) return 1;
  return clamp01((secondBestDelta - bestDelta) / angularTolerance);
}

export function requiredLaneDominance(avgVelocity) {
  const t = clamp01((avgVelocity - VELOCITY_COMMIT_START) / (VELOCITY_COMMIT_FULL - VELOCITY_COMMIT_START));
  return SLOW_LANE_DOMINANCE + t * (FAST_LANE_DOMINANCE - SLOW_LANE_DOMINANCE);
}

// ─── child placement ──────────────────────────────────────────────────

/**
 * Place children around their parent.
 *
 * 'corner' root level: quarter-fan from a bottom-right anchor across the
 * arc from pointing-left (π) to pointing-up (3π/2), with the endpoints
 * inset slightly so the edge options don't hug the window borders.
 *
 * Deeper levels (any mode): forward fan away from the grandparent
 * direction — the gesture keeps flowing in the direction it was going.
 * Corner mode tightens the spread to 130° so six options stay on-screen
 * near a window edge.
 */
export function placeChildren(parent, grandparent, count, radius, flowMode = "corner", stage = null) {
  if (count === 0) return [];
  if (!grandparent) {
    if (flowMode === "corner") {
      // 4+ options pull the endpoints nearly to the axes so slot 0 sits
      // at "straight left" and the last at "straight up".
      const inset = count > 3 ? 0.05 : 0.16;
      const start = Math.PI + inset;
      const end = Math.PI * 1.5 - inset;
      const step = count === 1 ? 0 : (end - start) / (count - 1);
      return Array.from({ length: count }, (_, i) => {
        const a = count === 1 ? (start + end) / 2 : start + i * step;
        return { x: parent.x + Math.cos(a) * radius, y: parent.y + Math.sin(a) * radius };
      });
    }
    // centered radial root — half-step rotation off 12 o'clock
    const step = (Math.PI * 2) / count;
    const start = -Math.PI / 2 + step / 2;
    return Array.from({ length: count }, (_, i) => {
      const a = start + i * step;
      return { x: parent.x + Math.cos(a) * radius, y: parent.y + Math.sin(a) * radius };
    });
  }
  let baseAngle = Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x);
  if (flowMode === "corner") {
    // Bias the fan center 25% toward the screen-interior diagonal (up-left
    // from a bottom-right anchor) so deeper rings lean into free space.
    const interior = -Math.PI * 0.75;
    let delta = interior - baseAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    baseAngle += delta * 0.25;
  }
  const spread = flowMode === "corner" ? Math.PI * 0.72 : Math.PI * 0.85;
  if (flowMode === "corner" && stage) {
    // Edge-aware layout: parents near a window edge would clamp half
    // their fan into a bunched smear. Instead, find the contiguous arc
    // of angles whose positions actually fit on-stage and lay the fan
    // inside it, as close to the continuation direction as it can sit.
    const fitted = fitArcToStage(parent, count, radius, stage, baseAngle, spread);
    if (fitted) return fitted;
  }
  const start = count === 1 ? baseAngle : baseAngle - spread / 2;
  const step = count === 1 ? 0 : spread / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const a = start + i * step;
    return { x: parent.x + Math.cos(a) * radius, y: parent.y + Math.sin(a) * radius };
  });
}

/**
 * Lay `count` children on the largest contiguous in-stage arc around
 * `centerAngle`, shrinking the spread only if the valid arc demands it.
 * Returns null when no valid angle exists (caller falls back to the
 * unfitted fan + position clamping).
 */
function fitArcToStage(parent, count, radius, stage, centerAngle, desiredSpread) {
  const m = stage.margin ?? 56;
  const ok = (a) => {
    const x = parent.x + Math.cos(a) * radius;
    const y = parent.y + Math.sin(a) * radius;
    return x >= m && x <= stage.w - m && y >= m && y <= stage.h - m;
  };
  const STEP = Math.PI / 180;
  let lo = centerAngle;
  let hi = centerAngle;
  if (!ok(centerAngle)) {
    let found = null;
    for (let d = STEP; d <= Math.PI; d += STEP) {
      if (ok(centerAngle + d)) { found = centerAngle + d; break; }
      if (ok(centerAngle - d)) { found = centerAngle - d; break; }
    }
    if (found == null) return null;
    lo = hi = found;
  }
  while (hi - lo < Math.PI * 1.5 && ok(hi + STEP)) hi += STEP;
  while (hi - lo < Math.PI * 1.5 && ok(lo - STEP)) lo -= STEP;
  if (hi <= lo) return null;
  const spread = Math.min(desiredSpread, hi - lo);
  // Sit the spread inside [lo, hi], as close to the continuation as fits.
  const center = Math.min(Math.max(centerAngle, lo + spread / 2), hi - spread / 2);
  const start = count === 1 ? center : center - spread / 2;
  const step = count === 1 ? 0 : spread / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const a = start + i * step;
    return { x: parent.x + Math.cos(a) * radius, y: parent.y + Math.sin(a) * radius };
  });
}

/** Smallest non-negative angle between two angles (radians). */
export function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

/** Clamp a position to within `margin` px of stage bounds. */
export function clampToStage(pos, stageSize, margin = 56) {
  return {
    x: Math.max(margin, Math.min(stageSize.w - margin, pos.x)),
    y: Math.max(margin, Math.min(stageSize.h - margin, pos.y)),
  };
}

/** Cubic ease-out — matches SMOOTH_OUT, for rAF-driven interpolation. */
export function eased(t) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}
