// Gesture commands — recognize deliberate meta-gestures in a pointer
// trail. Hand-ported from @mikeishiring/radial-dial gesture-commands.ts.
// Pure functions; no DOM, no framework.
//
// Commands: "reset" (a closed circle — cancel/dismiss), "next-flow" /
// "previous-flow" (long straight diagonal strokes). The quick dial only
// wires "reset"; the others ship for vendor fidelity.

const MIN_POINTS = 8;
const MIN_CIRCLE_SIZE = 44;
const MIN_LINE_DISTANCE = 110;

export function classifyGestureCommand(points) {
  if (!Array.isArray(points) || points.length < MIN_POINTS) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const bounds = measureBounds(points);
  const pathLength = measurePathLength(points);
  const direct = distance(first, last);
  const diagonal = Math.hypot(bounds.width, bounds.height);

  if (isCircleReset(points, bounds, pathLength, direct, diagonal)) return "reset";

  const straightness = direct / Math.max(pathLength, 1);
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (direct >= MIN_LINE_DISTANCE && straightness > 0.72) {
    if (dx > 85 && dy < -35) return "next-flow";
    if (dx < -85 && dy < -35) return "previous-flow";
  }

  return null;
}

function isCircleReset(points, bounds, pathLength, direct, diagonal) {
  if (bounds.width < MIN_CIRCLE_SIZE || bounds.height < MIN_CIRCLE_SIZE) return false;
  if (pathLength < diagonal * 2.05) return false;
  const closedEnough = direct < Math.max(42, diagonal * 0.34);
  if (!closedEnough) return false;

  const centroid = points.reduce(
    (sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y }),
    { x: 0, y: 0 },
  );
  centroid.x /= points.length;
  centroid.y /= points.length;

  let totalTurn = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = Math.atan2(points[i - 1].y - centroid.y, points[i - 1].x - centroid.x);
    const next = Math.atan2(points[i].y - centroid.y, points[i].x - centroid.x);
    totalTurn += signedAngleDelta(next, prev);
  }
  return Math.abs(totalTurn) > Math.PI * 1.45;
}

function measureBounds(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { width: maxX - minX, height: maxY - minY };
}

function measurePathLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function signedAngleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
