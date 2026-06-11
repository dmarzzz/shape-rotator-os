// Ink — math for capturing, smoothing, and rendering hand-drawn paths.
// Hand-ported from @mikeishiring/radial-dial ink.ts. Pure functions;
// no DOM, no framework. Points are { x, y, t, v } (v = px/ms).

/** Sparser captures than this get merged — larger = smoother + laggier. */
export const MIN_POINT_DISTANCE = 9;

/** Hard cap on points per stroke to keep SVG cheap on long gestures. */
export const MAX_TRAIL_POINTS = 240;

/** Velocity (px/ms) above which motion reads as "fast". */
export const FAST_VELOCITY = 1.4;

/** Velocity below which motion reads as "slow / deliberate". */
export const SLOW_VELOCITY = 0.15;

/**
 * Exponential smoothing factor — 0.55 produces a wet-paintbrush trail
 * that lags the cursor ~30-40ms, smoothing hand jitter. The raw cursor
 * still drives hit-testing; only the rendered ink lags.
 */
const SMOOTH_FACTOR = 0.55;

/**
 * Append a raw point to a stroke, computing velocity and exponentially
 * smoothing position vs. the previous point. Returns the unchanged
 * stroke array if the smoothed point is too close to the last.
 */
export function appendPoint(stroke, rawP, t) {
  const last = stroke[stroke.length - 1];
  if (!last) return [{ ...rawP, t, v: 0 }];
  const sx = last.x + (rawP.x - last.x) * (1 - SMOOTH_FACTOR);
  const sy = last.y + (rawP.y - last.y) * (1 - SMOOTH_FACTOR);
  const dx = sx - last.x;
  const dy = sy - last.y;
  const dist = Math.hypot(dx, dy);
  if (dist < MIN_POINT_DISTANCE) return stroke;
  const dt = Math.max(1, t - last.t);
  const v = dist / dt;
  const next = { x: sx, y: sy, t, v };
  if (stroke.length >= MAX_TRAIL_POINTS) {
    return [...stroke.slice(-(MAX_TRAIL_POINTS - 1)), next];
  }
  return [...stroke, next];
}

/** One continuous Catmull-Rom-smoothed SVG path string for a stroke. */
export function inkFullPath(points) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  }
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Trim a stroke at one end so it doesn't pass through a bubble's
 * interior — the line connects perimeters, like a flowchart edge.
 */
export function trimStrokeAtAnchor(points, anchor, radius, side) {
  if (points.length < 2) return points;
  if (side === "start") {
    let i = 0;
    while (i < points.length - 1 && Math.hypot(points[i].x - anchor.x, points[i].y - anchor.y) < radius) {
      i++;
    }
    return points.slice(i);
  }
  let i = points.length - 1;
  while (i > 0 && Math.hypot(points[i].x - anchor.x, points[i].y - anchor.y) < radius) {
    i--;
  }
  return points.slice(0, i + 1);
}

/**
 * Apply a soft magnetic pull on the rendered ink endpoint toward the
 * homed child as the cursor approaches commit threshold. Subtle: max
 * 14% pull, kicking in past 50% of the threshold.
 *
 * IMPORTANT: this only changes the *rendered* line, never the cursor
 * position used for hit-testing. The user's actual control is unchanged.
 */
export function applyMagneticPull(rawPoint, activePos, homedTarget, commitDistance) {
  if (!homedTarget) return rawPoint;
  const dist = Math.hypot(rawPoint.x - activePos.x, rawPoint.y - activePos.y);
  if (dist < commitDistance * 0.5) return rawPoint;
  const t = Math.min(1, (dist - commitDistance * 0.5) / (commitDistance * 0.5));
  const pull = t * 0.14;
  return {
    x: rawPoint.x + (homedTarget.x - rawPoint.x) * pull,
    y: rawPoint.y + (homedTarget.y - rawPoint.y) * pull,
  };
}

/**
 * Render a stroke as Catmull-Rom→Bézier segments, each with its own
 * velocity-derived width and opacity. Caller paints them oldest→newest.
 */
export function inkSegments(points, baseWidth) {
  if (points.length < 2) return [];
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    const d = `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    const v = p2.v;
    const width = velocityToStrokeWidth(v, baseWidth);
    // Fast strokes dip slightly transparent — a pen skipping over paper.
    const opacity = v > FAST_VELOCITY ? 0.78 : 1;
    segments.push({ d, width, opacity });
  }
  return segments;
}

/**
 * Pointer velocity (px/ms) → stroke width (px). Slow strokes pool
 * ~1.55× thick, fast strokes thin to ~0.62×.
 */
export function velocityToStrokeWidth(v, baseWidth) {
  const t = Math.max(0, Math.min(1, (v - SLOW_VELOCITY) / (FAST_VELOCITY - SLOW_VELOCITY)));
  const e = 1 - Math.pow(1 - t, 3);
  const MIN_SCALE = 0.62;
  const MAX_SCALE = 1.55;
  return baseWidth * (MAX_SCALE - e * (MAX_SCALE - MIN_SCALE));
}
