// quickdial — the "+" marking-menu in the bottom-right corner.
//
// Press, draw a line, release: ask / seek / offer expressed in seconds.
// The gesture engine + geometry are vendored ports of
// @mikeishiring/radial-dial (see vendor/radial-dial/); this module owns
// the vanilla render layer (SVG ink + bubble divs), the micro-composer,
// and the publish glue into the existing asks PR pipeline.
//
// Interaction grammar:
//   flick    — press the FAB, drag through two rings, release on a leaf
//   tap      — click the FAB to open; click bubbles to walk the tree
//   keyboard — Ctrl/Cmd+Shift+A opens; 1-9 select; Esc walks back
//
// Publish rails (demo wiring):
//   ask        → real PR flow: markdown → clipboard → github new-file URL
//   seek/offer → chip copied to clipboard + jump to the profile editor
//                (frontmatter list wiring is the Phase-2 follow-up —
//                 see docs/QUICK_DIAL_PRD.md)

import { createDialController } from "../vendor/radial-dial/dial-core.js";
import {
  COMMIT_RATIO,
  FAN_RADIUS_DEEP,
  FAN_RADIUS_ROOT,
  INK_BASE_WIDTH,
  clampToStage,
  placeChildren,
} from "../vendor/radial-dial/geometry.js";
import { applyMagneticPull, inkFullPath, inkSegments, trimStrokeAtAnchor } from "../vendor/radial-dial/ink.js";
import { classifyGestureCommand } from "../vendor/radial-dial/gestures.js";
import { appendChipToFrontmatter } from "./quickdial-frontmatter.js";
import { askVerbIconSvg, askVerbVars } from "./asks.js";
import { toast } from "./ux.js";
import { magnetize } from "./motion.js";
import { openWithQuery as openFindWithQuery } from "./find.js";
import { launchPRFlow, currentAskContext, quoteYaml, yamlScalar } from "./alchemy.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// ─── vocabulary ───────────────────────────────────────────────────────

// Mirrors ASK_VERB_OPTIONS in alchemy.js renderAsks — the stored verb
// string carries the emoji; the bubble renders the shared line icon.
const ASK_VERBS = [
  { glyph: "🤝", verb: "🤝 pair on", label: "pair on" },
  { glyph: "🎨", verb: "🎨 need 30 min with", label: "30 min with" },
  { glyph: "🔬", verb: "🔬 brain on", label: "brain on" },
  { glyph: "🧪", verb: "🧪 try this with me", label: "try with me" },
  { glyph: "📣", verb: "📣 looking for", label: "looking for" },
  { glyph: "🪛", verb: "🪛 help me debug", label: "help debug" },
];

// skill_areas vocab grouped into the six comment-groups of
// cohort-data/schema.yml — locked in docs/QUICK_DIAL_PRD.md.
const VOCAB_BUCKETS = [
  { id: "tee", label: "tee / trust", tags: ["tee", "dstack", "attestation", "formal-verification"] },
  { id: "crypto", label: "crypto", tags: ["zk", "post-quantum", "threshold-crypto", "mpc"] },
  { id: "agents", label: "agents", tags: ["agentic", "agent-runtime", "agent-routing"] },
  { id: "chain", label: "chain / mev", tags: ["mev", "cross-chain", "identity"] },
  { id: "infra", label: "infra", tags: ["p2p", "durable-workflows", "confidential-db"] },
  { id: "design", label: "design / gtm", tags: ["design", "bd-gtm", "research-to-product"] },
];

// Ring-2 carries an icon inside every orb — the bucket rings (seek/offer)
// were color + text only, which made siblings read as identical twins.
// Same Lucide line language as the ask verbs (asks.js ASK_VERB_ICONS).
const BUCKET_ICONS = {
  tee: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
  crypto: `<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>`,
  agents: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  chain: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  infra: `<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`,
  design: `<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>`,
};
const SEARCH_ICON = `<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`;
const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const BRANCH_HINTS = {
  ask: "this week — open for 5 days",
  seek: "standing — added to your profile",
  offer: "standing — people can DM you about it",
  search: "find anything in the os",
};

// Two-word qualifiers under the ring-1 labels — the trichotomy
// disambiguates at a glance instead of demanding a read.
const BRANCH_SUBS = {
  ask: "this week",
  seek: "want help",
  offer: "can help",
  search: "find",
};

// Galaxy hues — the membrane's blob cabochons (renderer/membrane/blob.js
// BLOB_PROFILES). ask wears the asks blob's amber; seek points at the
// cohort constellation (lapis); offer gives like events (jade). The FAB
// is a miniature self blob (oxide) — you, expressing.
const BRANCH_ORBS = {
  ask: { base: "#d49a1a", rim: "#FFE9B8", contour: "#FFC24A" },
  seek: { base: "#3850a8", rim: "#D4E0FF", contour: "#7AA0E0" },
  offer: { base: "#2a7a60", rim: "#D4F0E2", contour: "#5DAA8C" },
  // search is starlight — neutral warm-grey, distinct from every blob
  search: { base: "#6f6a64", rim: "#FFFFFF", contour: "#d9d4cc" },
};

// The shape-rotator vocabulary: every branch is a SOLID, not just a hue.
// seek = sphere, ask = octahedron (diamond), offer = hexagonal prism,
// search = lens (rounded square). The base anchor is a cube that rotates
// into the chosen branch's shape as you select.
const BRANCH_SHAPES = {
  ask: "polygon(50% 2%, 98% 50%, 50% 98%, 2% 50%)",
  seek: "circle(48% at 50% 50%)",
  offer: "polygon(25% 6.7%, 75% 6.7%, 100% 50%, 75% 93.3%, 25% 93.3%, 0% 50%)",
  search: "inset(8% round 32%)",
};

function branchOf(node) {
  if (!node) return null;
  return node.kind === "branch" ? node.id : node.kind;
}

function orbVars(node) {
  const branch = branchOf(node);
  const orb = BRANCH_ORBS[branch];
  if (!orb) return "";
  // a leaf wears its own gem everywhere it appears — bubble, path
  // marker, FAB facet — so the chosen shape survives the whole journey
  const shape = node.variant?.shape || BRANCH_SHAPES[branch] || "circle(48% at 50% 50%)";
  return `--qd-orb-base:${orb.base};--qd-orb-rim:${orb.rim};--qd-orb-contour:${orb.contour};--qd-shape:${shape}`;
}

// Ring-2 is a GEM TRAY, not a family of cuts: each slot in the ring is a
// categorically different solid — kite, delta, pentagon, star, octagon,
// plus — shared by index across every branch. (v1 used six subtle cuts
// of the parent solid; at 48px parametric variations of one polygon read
// as rendering errors, not siblings.) Hue carries the family, shape
// carries the option, and the keyboard numeral n always pairs with the
// same silhouette — the ring becomes muscle memory. Each gem also gets
// its own light (--qd-grad), so the tray glints instead of repeating.
const LEAF_SHAPES = [
  // kite — the tall gem
  { shape: "polygon(50% 0%, 90% 42%, 50% 100%, 10% 42%)", size: 52, grad: "36% 24%" },
  // delta — broad base, points up
  { shape: "polygon(50% 6%, 97% 92%, 3% 92%)", size: 50, grad: "50% 40%" },
  // pentagon
  { shape: "polygon(50% 2%, 98% 38%, 80% 98%, 20% 98%, 2% 38%)", size: 48, grad: "62% 26%" },
  // five-point star — the ring's one spiky moment
  { shape: "polygon(50% 0%, 63% 32%, 98% 35%, 72% 58%, 81% 94%, 50% 73%, 19% 94%, 28% 58%, 2% 35%, 37% 32%)", size: 56, grad: "50% 22%" },
  // octagon
  { shape: "polygon(30% 2%, 70% 2%, 98% 30%, 98% 70%, 70% 98%, 30% 98%, 2% 70%, 2% 30%)", size: 46, grad: "30% 50%" },
  // plus gem — arms wide enough to seat the 14px icon
  { shape: "polygon(32% 2%, 68% 2%, 68% 32%, 98% 32%, 98% 68%, 68% 68%, 68% 98%, 32% 98%, 32% 68%, 2% 68%, 2% 32%, 32% 32%)", size: 50, grad: "64% 60%" },
];

// Suggested tags for ask composing — recognition over recall. One
// representative tag per vocab bucket, click to toggle.
const ASK_TAG_SUGGESTIONS = ["tee", "zk", "agentic", "mev", "p2p", "design"];

// Ring 1 order maps to the corner arc: index 0 = left, last = up.
// ask sits on the diagonal — the natural flick direction.
const TREE = {
  id: "root",
  label: "+",
  children: [
    // index 0 sits at the straight-left slot of the corner arc — search
    // lives there so a due-west flick is always "find something"
    { id: "search", label: "search", kind: "branch" },
    {
      id: "seek", label: "seek", kind: "branch",
      children: VOCAB_BUCKETS.map((b) => ({ id: `seek:${b.id}`, label: b.label, kind: "seek", bucket: b })),
    },
    {
      id: "ask", label: "ask", kind: "branch",
      children: ASK_VERBS.map((v) => ({ id: `ask:${v.glyph}`, label: v.label, kind: "ask", verb: v.verb, glyph: v.glyph })),
    },
    {
      id: "offer", label: "offer", kind: "branch",
      children: VOCAB_BUCKETS.map((b) => ({ id: `offer:${b.id}`, label: b.label, kind: "offer", bucket: b })),
    },
  ],
};

// Stamp each leaf with its solid at definition time so bubbles, path
// markers, and the FAB facet all wear the SAME silhouette — object
// constancy from ring to marker to anchor.
for (const branch of TREE.children) {
  (branch.children || []).forEach((child, i) => {
    child.variant = LEAF_SHAPES[i % LEAF_SHAPES.length];
  });
}

const SEEN_LS_KEY = "srwk:quickdial_seen";

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// ─── mount ────────────────────────────────────────────────────────────

export function mountQuickDial() {
  if (document.getElementById("quick-dial")) return;

  const root = document.createElement("div");
  root.id = "quick-dial";
  root.dataset.state = "rest";
  root.innerHTML = `
    <div class="qd-scrim"></div>
    <svg class="qd-ink" aria-hidden="true"></svg>
    <div class="qd-layer"></div>
    <div class="qd-caption" aria-live="polite"></div>
    <form class="qd-composer" novalidate hidden></form>
    <button class="qd-fab" type="button" title="ask / seek / offer (Ctrl+Shift+A)"
            aria-label="quick ask, seek, or offer" aria-expanded="false" aria-haspopup="menu">
      <span class="qd-fab-core" aria-hidden="true">
        <span class="qd-fab-shape">
          <svg class="qd-fab-cube" viewBox="0 0 48 48">
            <polygon points="24,5 41,14.5 24,24 7,14.5" fill="#FFE6D4"/>
            <polygon points="7,14.5 24,24 24,43 7,33.5" fill="#8f250c"/>
            <polygon points="41,14.5 24,24 24,43 41,33.5" fill="#c43914"/>
          </svg>
          <span class="qd-fab-face"></span>
        </span>
        <span class="qd-fab-ring"></span>
        <span class="qd-fab-hints"><i style="--hx:-34px;--hy:-5px;--hi:0"></i><i style="--hx:-25px;--hy:-25px;--hi:1"></i><i style="--hx:-5px;--hy:-34px;--hi:2"></i></span>
      </span>
      <span class="qd-fab-whisper" aria-hidden="true">hold + draw</span>
    </button>
  `;
  document.body.appendChild(root);

  const scrim = root.querySelector(".qd-scrim");
  const inkSvg = root.querySelector(".qd-ink");
  const layer = root.querySelector(".qd-layer");
  const caption = root.querySelector(".qd-caption");
  const composer = root.querySelector(".qd-composer");
  const fab = root.querySelector(".qd-fab");
  const fabRing = root.querySelector(".qd-fab-ring");

  let uiState = "rest"; // rest | drawing | browse | composing
  let gestureActive = false;
  let wasOpenAtPress = false;
  let pressTravel = 0; // px the pointer moved during the current gesture
  let gesturePoints = []; // full raw trail (the controller window-caps its own)
  let staleGeometry = false; // window resized while the composer was open
  let composingLeaf = null;
  const drafts = new Map(); // leaf id → { topic, tags } — session only
  const bubbleEls = new Map(); // node id → element
  const markerEls = new Map(); // path index → element

  try {
    if (localStorage.getItem(SEEN_LS_KEY) !== "1") root.classList.add("qd-first");
  } catch {}
  // The whisper is a moment, not furniture: it bows out on its own after
  // ~14s even if the dial is never opened (the breathe keeps the quiet
  // discovery beacon; the first open still kills both forever).
  setTimeout(() => root.classList.add("qd-hinted"), 14000);

  const fabCenter = () => {
    const r = fab.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const pt = (e) => ({ x: e.clientX, y: e.clientY });

  const ctrl = createDialController({
    tree: TREE,
    flowMode: "corner",
    clamp: (p) => clampToStage(p, { w: window.innerWidth, h: window.innerHeight }, 56),
    stageFor: () => ({ w: window.innerWidth, h: window.innerHeight, margin: 56 }),
    onRender: () => scheduleRender(),
    // Drawing THROUGH the last layer opens its destination instantly —
    // the moment the line touches a leaf, the gesture is complete; no
    // waiting for the button to lift.
    onChange: ({ nodes }) => {
      const leaf = nodes[nodes.length - 1];
      if (!leaf || leaf.children?.length) return;
      if (uiState !== "drawing" || !gestureActive) return;
      queueMicrotask(() => {
        if (!gestureActive || uiState !== "drawing") return;
        gestureActive = false;
        gesturePoints = [];
        ctrl.pointerUp(ctrl.state.pointer || fabCenter());
        afterRelease(null);
      });
    },
  });

  // ─── render ─────────────────────────────────────────────────────────

  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    const run = () => {
      rafPending = false;
      render();
    };
    // rAF starves while the window is occluded/minimized (Chromium marks
    // fully-covered windows hidden) — a starved frame would wedge
    // rafPending and swallow every later render. Fall back to a timeout
    // whenever frames aren't flowing.
    if (document.visibilityState === "hidden") setTimeout(run, 16);
    else requestAnimationFrame(run);
  }

  function setState(next) {
    uiState = next;
    root.dataset.state = next;
    fab.setAttribute("aria-expanded", next === "rest" ? "false" : "true");
    scheduleRender();
  }

  // The dial yields to the app's modal surfaces: fork prompt, onboarding
  // step modals, any open aria-modal dialog, and the onboarding mode.
  function dialBlocked() {
    if (document.querySelector(".fork-prompt-backdrop, .alch-onb-modal-backdrop")) return true;
    for (const el of document.querySelectorAll('[aria-modal="true"]')) {
      if (el.closest("#quick-dial")) continue;
      if (!el.hidden && getComputedStyle(el).display !== "none") return true;
    }
    const mode = document.querySelector("[data-alch-mode-current]")?.getAttribute("data-alch-mode-current");
    return mode === "onboarding" && document.body.dataset.activeTab === "alchemy";
  }

  function ringOneLocal() {
    const origin = fabCenter();
    const positions = placeChildren(origin, null, TREE.children.length, FAN_RADIUS_ROOT, "corner")
      .map((p) => clampToStage(p, { w: window.innerWidth, h: window.innerHeight }, 56));
    return TREE.children.map((node, i) => ({ node, pos: positions[i] }));
  }

  function currentOptions() {
    if (uiState === "rest" || uiState === "composing") return [];
    if (ctrl.state.path.length > 0) return ctrl.visibleChildren();
    return uiState === "browse" ? ringOneLocal() : [];
  }

  // Bubbles are membrane-galaxy orbs: a glowing cabochon with its label
  // BELOW, exactly like the cohort/events/asks blobs in the void. Ring-1
  // orbs are pure (no icon) — the hue + label carry it; verb leaves keep
  // their white line icon inside the orb for six-way recognition.
  function bubbleHtml(node) {
    const sub = node.kind === "branch" ? BRANCH_SUBS[node.id] : "";
    let inner = "";
    if (node.kind === "ask" && node.glyph) {
      inner = askVerbIconSvg(node.glyph) || "";
    } else if (node.bucket && BUCKET_ICONS[node.bucket.id]) {
      inner = svgIcon(BUCKET_ICONS[node.bucket.id]);
    } else if (node.id === "search") {
      inner = svgIcon(SEARCH_ICON);
    }
    return `
      <span class="qd-bubble-orb">${inner}</span>
      <span class="qd-bubble-label">${escHtml(node.label)}</span>${
        sub ? `<span class="qd-bubble-sub">${escHtml(sub)}</span>` : ""
      }`;
  }

  function syncBubbles(options) {
    const want = new Set(options.map((o) => o.node.id));
    const activeNode = ctrl.state.path[ctrl.state.path.length - 1]?.node;
    for (const [id, el] of bubbleEls) {
      if (!want.has(id)) {
        bubbleEls.delete(id);
        // The chosen bubble collapses in place into its path marker;
        // unchosen siblings retract toward the anchor they bloomed from.
        el.classList.add("leaving");
        if (activeNode && id === activeNode.id) el.classList.add("chosen");
        setTimeout(() => el.remove(), 200);
      }
    }
    // Anchor the bloom: bubbles travel OUT from where the gesture is —
    // the press point teaches "drag toward these" without a word.
    const anchor = ctrl.state.path.length > 0
      ? ctrl.state.path[ctrl.state.path.length - 1].pos
      : fabCenter();
    options.forEach((opt, i) => {
      let el = bubbleEls.get(opt.node.id);
      if (!el) {
        el = document.createElement("button");
        el.type = "button";
        el.className = "qd-bubble";
        el.dataset.kind = opt.node.kind || "branch";
        el.style.setProperty("--qd-i", String(i));
        el.style.setProperty("--qd-dx", `${(anchor.x - opt.pos.x).toFixed(1)}px`);
        el.style.setProperty("--qd-dy", `${(anchor.y - opt.pos.y).toFixed(1)}px`);
        const orb = orbVars(opt.node);
        if (orb) el.style.cssText += `;${orb}`;
        // ring-2 wears its own gem (shape arrives via orbVars); size and
        // light are per-slot so the tray glints instead of repeating
        const variant = opt.node.variant;
        if (variant) {
          if (variant.size) el.style.setProperty("--qd-orb-size", `${variant.size}px`);
          if (variant.grad) el.style.setProperty("--qd-grad", variant.grad);
        }
        el.innerHTML = bubbleHtml(opt.node);
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        el.addEventListener("click", () => handleNodeClick(opt.node));
        layer.appendChild(el);
        bubbleEls.set(opt.node.id, el);
      }
      el.style.left = `${opt.pos.x}px`;
      el.style.top = `${opt.pos.y}px`;
      // numeral badge for the keyboard path (visible only under .qd-kbd)
      el.dataset.n = String(i + 1);
    });

    // Homed highlight — the only thing glowing at any moment. The homed
    // orb also LEANS toward the cursor (the package's magnetic pull,
    // 18% × confidence, capped) — the option reaches back at you.
    const h = ctrl.homed();
    const posById = new Map(options.map((o) => [o.node.id, o.pos]));
    for (const [id, el] of bubbleEls) {
      const on = h && h.id === id;
      el.classList.toggle("is-homed", !!on);
      const bp = posById.get(id);
      if (on && ctrl.state.pointer && bp) {
        el.style.setProperty("--qd-strength", h.strength.toFixed(3));
        let dx = (ctrl.state.pointer.x - bp.x) * 0.18 * h.strength;
        let dy = (ctrl.state.pointer.y - bp.y) * 0.18 * h.strength;
        const m = Math.hypot(dx, dy);
        if (m > 12) {
          dx *= 12 / m;
          dy *= 12 / m;
        }
        el.style.setProperty("--qd-pull-x", `${dx.toFixed(1)}px`);
        el.style.setProperty("--qd-pull-y", `${dy.toFixed(1)}px`);
      } else {
        el.style.removeProperty("--qd-pull-x");
        el.style.removeProperty("--qd-pull-y");
      }
    }
  }

  function syncMarkers(path) {
    const want = path.length > 1 ? path.slice(1) : [];
    for (const [idx, el] of markerEls) {
      if (idx >= want.length) {
        markerEls.delete(idx);
        el.remove();
      }
    }
    want.forEach((entry, i) => {
      let el = markerEls.get(i);
      const isActive = i === want.length - 1 && uiState !== "composing";
      if (!el) {
        el = document.createElement("div");
        el.dataset.born = String(performance.now());
        markerEls.set(i, el);
        layer.appendChild(el);
      }
      // No label — a committed node is a small glowing orb in the
      // constellation, not a floating text bar. The ring's hue and the
      // caption already carry "where am I". Pops on arrival (the chosen
      // bubble collapses into it); the class is recomputed every render,
      // so keep the pop only while its animation is still running.
      const fresh = performance.now() - Number(el.dataset.born || 0) < 320;
      el.className = `qd-node${isActive ? " qd-node-active" : ""}${isActive && fresh ? " qd-node-pop" : ""}`;
      const orb = orbVars(entry.node);
      if (orb) el.style.cssText += `;${orb}`;
      el.style.left = `${entry.pos.x}px`;
      el.style.top = `${entry.pos.y}px`;
    });
  }

  // Ink is retained-mode: frozen strokes keep their <path> element so a
  // freshly laid stroke can settle (width relax) or draw in (dashoffset)
  // — innerHTML rebuilds would kill those transitions mid-flight. Only
  // the live stroke's segment group rebuilds each frame.
  const inkEls = new Map(); // stroke id → <path>
  let liveInkEl = null;
  function resetInk() {
    inkSvg.innerHTML = "";
    inkEls.clear();
    liveInkEl = null;
  }
  function trimmedFrozenPath(stg, stroke, i) {
    let pts = stroke.points;
    const startAnchor = stg.path[i]?.pos || null;
    if (startAnchor) pts = trimStrokeAtAnchor(pts, startAnchor, i === 0 ? 26 : 10, "start");
    // End trim reaches the orb's rim (24px radius), not its centre —
    // the line connects to the cabochon like a constellation edge.
    const endAnchor = stg.path[i + 1]?.pos;
    if (endAnchor) pts = trimStrokeAtAnchor(pts, endAnchor, 26, "end");
    return inkFullPath(pts);
  }
  function mountFrozenStroke(stg, stroke, i) {
    const el = document.createElementNS(SVG_NS, "path");
    el.setAttribute("class", "qd-ink-frozen");
    el.setAttribute("d", trimmedFrozenPath(stg, stroke, i));
    inkSvg.insertBefore(el, liveInkEl);
    inkEls.set(stroke.id, el);
    const w = INK_BASE_WIDTH * 1.05;
    if (stroke.synth) {
      // Click-synthesized stroke: draw in from the anchor, like a hand
      // tracing the line the drag would have made.
      el.style.strokeWidth = `${w.toFixed(2)}px`;
      try {
        const len = el.getTotalLength();
        if (len > 0) {
          el.style.strokeDasharray = `${len}`;
          el.style.strokeDashoffset = `${len}`;
          const anim = el.animate(
            [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
            { duration: 240, easing: "cubic-bezier(0.19, 1, 0.22, 1)" },
          );
          anim.onfinish = () => {
            el.style.strokeDasharray = "";
            el.style.strokeDashoffset = "";
          };
        }
      } catch {}
    } else {
      // Drag-frozen stroke: ink lays down — brief thicken, then relax.
      el.style.strokeWidth = `${(w * 1.6).toFixed(2)}px`;
      void el.getBoundingClientRect(); // flush so the relax transitions
      el.style.strokeWidth = `${w.toFixed(2)}px`;
    }
  }
  function renderInk(stg) {
    if (uiState === "rest") {
      if (inkSvg.firstChild) resetInk();
      return;
    }
    if (!liveInkEl || !inkSvg.contains(liveInkEl)) {
      resetInk();
      liveInkEl = document.createElementNS(SVG_NS, "g");
      inkSvg.appendChild(liveInkEl);
    }
    if (Number(inkSvg.getAttribute("width")) !== window.innerWidth ||
        Number(inkSvg.getAttribute("height")) !== window.innerHeight) {
      inkSvg.setAttribute("width", window.innerWidth);
      inkSvg.setAttribute("height", window.innerHeight);
      inkSvg.setAttribute("viewBox", `0 0 ${window.innerWidth} ${window.innerHeight}`);
    }
    const want = new Set();
    stg.frozenStrokes.forEach((stroke, i) => {
      want.add(stroke.id);
      if (!inkEls.has(stroke.id)) mountFrozenStroke(stg, stroke, i);
    });
    for (const [id, el] of inkEls) {
      if (!want.has(id)) {
        inkEls.delete(id);
        el.remove();
      }
    }
    // Live stroke — trimmed at the active anchor so it emerges from the
    // marker's rim (or the FAB's, at depth 0), never from underneath it.
    let livePts = stg.liveStroke;
    const active = stg.path[stg.path.length - 1];
    if (active && livePts.length > 1) {
      livePts = trimStrokeAtAnchor(livePts, active.pos, stg.path.length === 1 ? 26 : 12, "start");
      // The rendered ink tip bends toward the homed orb as the cursor
      // nears commit — the line wants the target (render-only; never
      // affects hit-testing).
      const h = ctrl.homed();
      if (h && livePts.length > 1) {
        const commitDist = (stg.path.length === 1 ? FAN_RADIUS_ROOT : FAN_RADIUS_DEEP) * COMMIT_RATIO;
        const last = livePts[livePts.length - 1];
        const pulled = applyMagneticPull(last, active.pos, h.targetPos, commitDist);
        livePts = [...livePts.slice(0, -1), { ...last, x: pulled.x, y: pulled.y }];
      }
    }
    let html = "";
    for (const seg of inkSegments(livePts, INK_BASE_WIDTH)) {
      html += `<path class="qd-ink-live" d="${seg.d}" stroke-width="${seg.width.toFixed(2)}" opacity="${seg.opacity}"/>`;
    }
    liveInkEl.innerHTML = html;
  }

  function updateCaption() {
    if (uiState === "rest" || uiState === "composing") {
      caption.textContent = "";
      return;
    }
    const nodes = ctrl.state.path.slice(1).map((e) => e.node);
    let homedBranch = "";
    if (!nodes.length && uiState === "drawing") {
      homedBranch = ctrl.homed()?.id || "";
    }
    const branchId = nodes[0]?.id || homedBranch;
    const crumb = nodes.map((n) => n.label).join(" ▸ ") || homedBranch;
    const fallback = uiState === "drawing"
      ? "draw, then release"
      : "click — or hold + draw";
    const hint = BRANCH_HINTS[branchId] || fallback;
    const text = crumb ? `${crumb} · ${hint}` : hint;
    if (caption.textContent !== text) {
      caption.textContent = text;
      // micro fade-up on change — the whisper breathes instead of snapping
      caption.classList.remove("swap");
      void caption.offsetWidth;
      caption.classList.add("swap");
    }
  }

  // The shape rotator's namesake: the base cube ROTATES into the shape
  // of whatever branch you're choosing. Aiming gives a soft preview
  // crossfade; an actual commit earns the full 3D TURN — one object
  // rotating to reveal its next facet, with a ring pulse at the moment
  // of the turn. Back to the cube at rest, with the same turn.
  let lastBaseBranch = null;
  let lastFacetLeaf = null;
  let turnTimer = 0;
  let facetTimer = 0;
  function syncBaseShape() {
    const committedBranch = branchOf(ctrl.state.path[1]?.node) || null;
    // a committed LEAF puts its own gem on the anchor — the journey's
    // shape rides with you: cube → branch solid → chosen gem
    const leaf = committedBranch ? ctrl.state.path[2]?.node || null : null;
    let branchId = committedBranch;
    let preview = false;
    if (!branchId && uiState === "drawing") {
      branchId = ctrl.homed()?.id || null;
      preview = !!branchId;
    }
    const orb = BRANCH_ORBS[branchId];
    if (branchId && orb) {
      root.dataset.branch = branchId;
      if (preview) root.dataset.preview = "1";
      else delete root.dataset.preview;
      root.style.setProperty("--qd-orb-base", orb.base);
      root.style.setProperty("--qd-orb-rim", orb.rim);
      root.style.setProperty("--qd-orb-contour", orb.contour);
      root.style.setProperty("--qd-shape",
        leaf?.variant?.shape || BRANCH_SHAPES[branchId] || "circle(48% at 50% 50%)");
    } else {
      delete root.dataset.branch;
      delete root.dataset.preview;
    }
    const shape = root.querySelector(".qd-fab-shape");
    if (committedBranch !== lastBaseBranch) {
      lastBaseBranch = committedBranch;
      lastFacetLeaf = leaf?.id || null;
      if (shape) {
        shape.classList.remove("turning", "facet");
        void shape.offsetWidth;
        shape.classList.add("turning");
        // the class must not outlive the turn — a lingering .turning
        // would replay stale animations on later preview flickers
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => shape.classList.remove("turning"), 460);
      }
      if (fabRing) {
        fabRing.classList.remove("on");
        void fabRing.offsetWidth;
        fabRing.classList.add("on");
      }
    } else if ((leaf?.id || null) !== lastFacetLeaf) {
      // same solid, new facet: branch↔leaf movement flips the face in
      // from edge-on — lighter than the cube turn, no ring pulse. The
      // full turn above owns branch changes; this owns depth changes.
      lastFacetLeaf = leaf?.id || null;
      if (shape && committedBranch) {
        shape.classList.remove("facet");
        void shape.offsetWidth;
        shape.classList.add("facet");
        clearTimeout(facetTimer);
        facetTimer = setTimeout(() => shape.classList.remove("facet"), 380);
      }
    }
  }

  function render() {
    syncBubbles(currentOptions());
    syncMarkers(ctrl.state.path);
    renderInk(ctrl.state);
    updateCaption();
    syncBaseShape();
  }

  // ─── open / close / navigate ────────────────────────────────────────

  function markSeen() {
    if (!root.classList.contains("qd-first")) return;
    root.classList.remove("qd-first");
    try { localStorage.setItem(SEEN_LS_KEY, "1"); } catch {}
  }

  function closeAll({ restoreFocus = true } = {}) {
    const hadFocus = root.contains(document.activeElement);
    composingLeaf = null;
    composer.hidden = true;
    composer.innerHTML = "";
    staleGeometry = false;
    root.classList.remove("qd-kbd");
    ctrl.reset();
    setState("rest");
    if (restoreFocus && hadFocus) fab.focus({ preventScroll: true });
  }

  function closeComposer() {
    composingLeaf = null;
    composer.hidden = true;
    composer.innerHTML = "";
    if (staleGeometry) {
      // The window resized while composing — the fan's stored positions
      // are stale, so close instead of reopening a misplaced ring.
      closeAll();
      return;
    }
    ctrl.back(); // pop the leaf so its ring shows again
    setState("browse");
  }

  // Search belongs to the global find overlay. Earlier quickdial builds
  // mounted a second bottom-right glass input; when empty it read as a
  // stray capsule attached to the FAB. Route directly to the real search
  // surface instead, then bow the dial out.
  function openSearch() {
    closeAll({ restoreFocus: false });
    try { openFindWithQuery(""); } catch {}
  }

  function routeLeaf(leaf) {
    if (leaf.id === "search") openSearch();
    else openComposer(leaf);
  }

  function handleNodeClick(node) {
    markSeen();
    if (ctrl.state.path.length === 0) ctrl.selectChild(node, fabCenter());
    else ctrl.selectChild(node);
    // Guard against stale clicks (a bubble mid-exit after the path moved):
    // only proceed if the controller actually committed this node.
    const committed = ctrl.state.path[ctrl.state.path.length - 1]?.node;
    if (committed?.id !== node.id) {
      setState(uiState === "rest" ? "rest" : "browse");
      return;
    }
    if (!node.children?.length) routeLeaf(node);
    else setState("browse");
  }

  function afterRelease(command) {
    const stg = ctrl.state;
    if (stg.phase === "committed" && stg.committed?.length) {
      const leaf = stg.committed[stg.committed.length - 1];
      if (!leaf.children?.length) routeLeaf(leaf);
      else setState("browse");
      return;
    }
    // A scribbled circle is a deliberate cancel — dismiss entirely.
    if (command === "reset") {
      closeAll();
      return;
    }
    // No selection. A true tap (sub-8px travel) on the open dial's ×
    // closes it; an abandoned drag re-presents the ring instead of
    // punishing the hesitation with a close.
    if (wasOpenAtPress && pressTravel < 8) closeAll();
    else setState("browse");
  }

  // ─── composer ───────────────────────────────────────────────────────

  function crumbsHtml(leaf) {
    const nodes = ctrl.state.path.slice(1).map((e) => e.node);
    return nodes
      .map((n, i) => {
        const last = i === nodes.length - 1;
        const icon = n.kind === "ask" && n.glyph ? (askVerbIconSvg(n.glyph) || "") : "";
        return `<button type="button" class="qd-crumb${last ? " is-leaf" : ""}" data-crumb="${i}" ${last ? "disabled" : ""}>
          ${icon}<span>${escHtml(n.label)}</span></button>`;
      })
      .join(`<span class="qd-crumb-sep" aria-hidden="true">▸</span>`);
  }

  function openComposer(leaf) {
    composingLeaf = leaf;
    setState("composing");
    const draft = drafts.get(leaf.id) || {};
    const ctx = currentAskContext();
    const unclaimed = ctx.authorSlug === "your-slug";

    // Without a claimed profile nothing can be posted — the primary action
    // becomes the claim itself instead of a submit that can only fail.
    const primaryBtn = unclaimed
      ? `<button class="qd-submit" type="button" data-qd-claim>claim profile →</button>`
      : null;

    const hasDraft = !!(String(draft.topic || "").trim() || String(draft.tags || "").trim());
    const draftNote = hasDraft ? ` · draft kept` : "";

    if (leaf.kind === "ask") {
      // Tags are pickable, not recalled: one representative tag per
      // vocab bucket, click to toggle into the field.
      const tagChips = ASK_TAG_SUGGESTIONS.map((t) =>
        `<button type="button" class="qd-tag" data-qd-tag="${escHtml(t)}" aria-pressed="false">${escHtml(t)}</button>`,
      ).join("") + `<button type="button" class="qd-tag qd-tag-add" data-qd-tag-add aria-label="add your own tag" title="add your own">+</button>`;
      composer.innerHTML = `
        <div class="qd-crumbs"${leaf.glyph ? ` style="${askVerbVars(leaf.glyph) || ""}"` : ""}>${crumbsHtml(leaf)}</div>
        <textarea class="qd-input qd-topic" name="topic" rows="2" required
          placeholder="the concrete ask — one line, link welcome">${escHtml(draft.topic || "")}</textarea>
        <input class="qd-input qd-tags" name="tags" type="text"
          placeholder="tags (optional)" value="${escHtml(draft.tags || "")}" />
        <div class="qd-tagrow" role="group" aria-label="suggested tags">${tagChips}</div>
        <div class="qd-tagrow-custom" hidden>
          <input class="qd-input qd-tag-input" type="text" maxlength="40"
            placeholder="your own tag — enter to add, esc to cancel" />
        </div>
        <div class="qd-meta">${
          unclaimed
            ? `claim your cohort profile before posting`
            : `posting as <strong>${escHtml(ctx.authorSlug)}</strong> · open for 5 days${draftNote}`
        }</div>
        <div class="qd-row">
          ${primaryBtn || `<button class="qd-submit" type="submit">post → PR</button>`}
          <button class="qd-alt" type="button" data-qd-board>full board ↗</button>
        </div>
        <div class="qd-result" hidden></div>`;
    } else {
      const isSeek = leaf.kind === "seek";
      const field = isSeek ? "seeking" : "offering";
      // The chosen bucket earns its keep: its vocab becomes one-click
      // starters while the field is empty.
      const starterChips = leaf.bucket.tags.map((t) =>
        `<button type="button" class="qd-tag" data-qd-starter="${escHtml(t)}">${escHtml(t)}</button>`,
      ).join("") + `<button type="button" class="qd-tag qd-tag-add" data-qd-tag-add aria-label="start from your own topic" title="your own">+</button>`;
      composer.innerHTML = `
        <div class="qd-crumbs">${crumbsHtml(leaf)}</div>
        <textarea class="qd-input qd-topic" name="topic" rows="2" required
          placeholder="${isSeek ? "what you want help with" : "what people can DM you about"} — one line">${escHtml(draft.topic || "")}</textarea>
        <div class="qd-tagrow" data-qd-starters role="group" aria-label="start from a topic"${String(draft.topic || "").trim() ? " hidden" : ""}>${starterChips}</div>
        <div class="qd-tagrow-custom" hidden>
          <input class="qd-input qd-tag-input" type="text" maxlength="40"
            placeholder="your own topic stem — enter to use, esc to cancel" />
        </div>
        <div class="qd-meta">${
          unclaimed
            ? `claim your cohort profile first — chips live on it`
            : `standing · lives on your profile under <strong>${field}</strong>${draftNote}`
        }</div>
        <div class="qd-row">
          ${primaryBtn || `<button class="qd-submit" type="submit">add to profile → PR</button>`}
          <button class="qd-alt" type="button" data-qd-board>full board ↗</button>
        </div>
        <div class="qd-result" hidden></div>`;
    }
    // close button — top-right, dismisses the whole dial (Esc walks back
    // a level instead; the crumbs pop to a specific one)
    composer.insertAdjacentHTML("afterbegin",
      `<button type="button" class="qd-composer-x" aria-label="close" title="close (Esc walks back)">×</button>`);
    composer.hidden = false;
    wireComposerChips(leaf);
    composer.querySelector(".qd-composer-x")?.addEventListener("click", () => closeAll());
    composer.querySelector("[data-qd-claim]")?.addEventListener("click", () => {
      closeAll();
      jumpTo("profile");
    });
    composer.querySelectorAll(".qd-input").forEach((input) => {
      input.addEventListener("input", () => {
        drafts.set(leaf.id, {
          topic: composer.elements.topic?.value || "",
          tags: composer.elements.tags?.value || "",
        });
      });
    });
    composer.querySelectorAll(".qd-crumb[data-crumb]:not([disabled])").forEach((b) => {
      b.addEventListener("click", () => {
        composingLeaf = null;
        composer.hidden = true;
        composer.innerHTML = "";
        ctrl.popToLevel(Number(b.dataset.crumb));
        setState("browse");
      });
    });
    composer.querySelector("[data-qd-board]")?.addEventListener("click", () => {
      const carry = leaf.kind === "ask"
        ? { leaf, topic: composer.elements.topic?.value || "", tags: composer.elements.tags?.value || "" }
        : null;
      closeAll();
      jumpTo("asks", { openComposer: true });
      if (carry && (carry.topic.trim() || carry.tags.trim())) prefillBoardComposer(carry);
    });
    requestAnimationFrame(() => composer.elements.topic?.focus?.());
  }

  // Carry a dial draft into the full board composer. The board form has
  // no prefill API, so this reaches for its fields after the jump and
  // degrades to a no-op if the board's markup ever changes.
  function prefillBoardComposer({ leaf, topic, tags }) {
    let tries = 0;
    const tick = () => {
      const form = document.querySelector("form.alch-asks-compose");
      if (form?.elements?.topic) {
        if (topic.trim()) form.elements.topic.value = topic;
        if (tags.trim() && form.elements.skill_areas) form.elements.skill_areas.value = tags;
        if (leaf?.verb && form.elements.verb) {
          form.elements.verb.value = leaf.verb;
          form.querySelectorAll("[data-asks-verb]").forEach((b) => {
            b.setAttribute("aria-pressed", b.dataset.asksVerb === leaf.verb ? "true" : "false");
          });
        }
        return;
      }
      if (++tries < 40) setTimeout(tick, 120);
    };
    tick();
  }

  // Suggested-tag toggles (ask), bucket starters (seek/offer), and the
  // "+" pill that mints your own — suggestions are a starting set, never
  // a closed one.
  function wireComposerChips(leaf) {
    const topic = composer.elements.topic;
    const tags = composer.elements.tags;
    const addBtn = composer.querySelector("[data-qd-tag-add]");

    const syncTagPressed = () => {
      const list = String(tags?.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      composer.querySelectorAll("[data-qd-tag]").forEach((b) => {
        b.setAttribute("aria-pressed", list.includes(b.dataset.qdTag.toLowerCase()) ? "true" : "false");
      });
    };
    const toggleTag = (tag) => {
      const list = String(tags.value || "").split(",").map((s) => s.trim()).filter(Boolean);
      const i = list.findIndex((s) => s.toLowerCase() === tag.toLowerCase());
      if (i >= 0) list.splice(i, 1);
      else list.push(tag);
      tags.value = list.join(", ");
      tags.dispatchEvent(new Event("input"));
      syncTagPressed();
    };
    const wireTagPill = (b) => b.addEventListener("click", () => toggleTag(b.dataset.qdTag));
    const mintTagPill = (tag) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "qd-tag";
      b.dataset.qdTag = tag;
      b.setAttribute("aria-pressed", "false");
      b.textContent = tag;
      addBtn.before(b);
      wireTagPill(b);
    };
    composer.querySelectorAll("[data-qd-tag]").forEach(wireTagPill);
    if (tags) {
      tags.addEventListener("input", syncTagPressed);
      // a kept draft may carry custom tags — re-mint their pills so the
      // row and the field stay one thing
      if (leaf.kind === "ask" && addBtn) {
        const known = new Set(ASK_TAG_SUGGESTIONS.map((t) => t.toLowerCase()));
        String(tags.value || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((t) => {
          if (!known.has(t.toLowerCase())) {
            known.add(t.toLowerCase());
            mintTagPill(t.toLowerCase());
          }
        });
      }
    }
    syncTagPressed();

    const useStarter = (stem) => {
      topic.value = `${stem}: `;
      topic.dispatchEvent(new Event("input"));
      topic.focus();
      try { topic.setSelectionRange(topic.value.length, topic.value.length); } catch {}
    };
    const starters = composer.querySelector("[data-qd-starters]");
    composer.querySelectorAll("[data-qd-starter]").forEach((b) => {
      b.addEventListener("click", () => useStarter(b.dataset.qdStarter));
    });
    if (starters && topic) {
      topic.addEventListener("input", () => {
        starters.hidden = topic.value.trim().length > 0;
      });
    }

    // the "+" pill: reveal a small input beneath the row; Enter mints an
    // ask tag (pressed pill + field) or becomes a seek/offer topic stem
    const customRow = composer.querySelector(".qd-tagrow-custom");
    const customInput = customRow?.querySelector(".qd-tag-input");
    if (addBtn && customRow && customInput) {
      addBtn.addEventListener("click", () => {
        customRow.hidden = !customRow.hidden;
        if (!customRow.hidden) customInput.focus();
      });
      customInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault(); // never submit the form from here
        const val = customInput.value.trim();
        if (!val) return;
        if (leaf.kind === "ask") {
          const tag = val.toLowerCase().replace(/,/g, " ").trim();
          if (!composer.querySelector(`[data-qd-tag="${CSS.escape(tag)}"]`)) mintTagPill(tag);
          const list = String(tags.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
          if (!list.includes(tag)) toggleTag(tag);
          else syncTagPressed();
        } else {
          useStarter(val);
        }
        customInput.value = "";
        customRow.hidden = true;
      });
    }
  }

  // A submit with no topic nudges the field instead of failing silently.
  function nudgeTopic() {
    const topic = composer.elements.topic;
    if (!topic) return;
    topic.classList.remove("qd-nudge");
    void topic.offsetWidth;
    topic.classList.add("qd-nudge");
    topic.focus();
  }

  composer.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!composingLeaf) return;
    if (composingLeaf.kind === "ask") submitAsk(composingLeaf);
    else submitChip(composingLeaf);
  });

  function composerResult(html, kind = "info") {
    const el = composer.querySelector(".qd-result");
    if (!el) return;
    el.hidden = false;
    el.dataset.kind = kind;
    el.innerHTML = html;
  }

  async function submitAsk(leaf) {
    const topic = String(composer.elements.topic?.value || "").trim();
    const tagsRaw = String(composer.elements.tags?.value || "").trim();
    if (!topic) {
      nudgeTopic();
      return;
    }
    const ctx = currentAskContext();
    if (ctx.authorSlug === "your-slug") return; // claim CTA owns this state
    const skillAreas = tagsRaw
      ? tagsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];
    const todayIso = new Date().toISOString().slice(0, 10);

    // Mirrors submitAskCompose in alchemy.js: deterministic 4-char topic
    // hash so a re-submit lands on the same path instead of duplicating.
    let h = 2166136261 >>> 0;
    for (let i = 0; i < topic.length; i++) {
      h ^= topic.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const recordId = `${ctx.authorSlug}-${todayIso}-${h.toString(36).slice(0, 4)}`;
    const tagsBlock = skillAreas.length
      ? "skill_areas:\n" + skillAreas.map((s) => `  - ${quoteYaml(s)}`).join("\n")
      : "skill_areas: []";
    const markdown = `---
record_id: ${recordId}
record_type: ask
schema_version: 1
posted_at: ${todayIso}
author: ${quoteYaml(ctx.authorSlug)}
verb: ${quoteYaml(leaf.verb)}
topic: ${yamlScalar(topic, 2)}
${tagsBlock}
status: open
---
(optional body — extra context for the ask.)
`;
    const btn = composer.querySelector(".qd-submit");
    if (btn) {
      btn.disabled = true;
      btn.dataset.busy = "1";
      btn.textContent = "opening github…";
    }
    try { await window.api?.clipboardWrite?.(markdown); } catch {}
    const launched = await launchPRFlow({
      kind: "new",
      path: `cohort-data/asks/${recordId}.md`,
      value: markdown,
    });
    if (!launched.ok) {
      if (btn) {
        btn.disabled = false;
        delete btn.dataset.busy;
        btn.textContent = "post → PR";
      }
      composerResult(`<strong>fork first</strong> — once your fork exists, submit again. your draft is kept.`, "error");
      return;
    }
    if (btn) {
      delete btn.dataset.busy;
      btn.textContent = "posted ✓";
    }
    // Mirror the board composer: stay open with the inline result so the
    // user keeps the reopen link; the FAB tick marks the handoff.
    drafts.delete(leaf.id);
    composerResult(`<strong>github opened</strong> — commit the file there; github turns it into a PR. <button type="button" class="qd-link" data-qd-reopen>reopen editor</button>`);
    composer.querySelector("[data-qd-reopen]")?.addEventListener("click", () => {
      try { window.api?.openExternal?.(launched.url); } catch {}
    });
    root.classList.add("qd-sent");
    setTimeout(() => root.classList.remove("qd-sent"), 2000);
  }

  // Fetch the FULL person file (frontmatter + body) from upstream main —
  // same source the rest of the app edits against (see fetchExistingBody
  // in alchemy.js, which returns only the body).
  async function fetchFullFile(path) {
    const url = `https://raw.githubusercontent.com/dmarzzz/shape-rotator-os/main/${path}?ts=${Date.now()}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
  }

  async function submitChip(leaf) {
    const chip = String(composer.elements.topic?.value || "").trim();
    if (!chip) {
      nudgeTopic();
      return;
    }
    const ctx = currentAskContext();
    if (ctx.authorSlug === "your-slug") return; // claim CTA owns this state
    const field = leaf.kind === "seek" ? "seeking" : "offering";
    const path = `cohort-data/people/${ctx.authorSlug}.md`;
    const btn = composer.querySelector(".qd-submit");
    if (btn) {
      btn.disabled = true;
      btn.dataset.busy = "1";
      btn.textContent = "fetching profile…";
    }
    const restoreBtn = () => {
      if (!btn) return;
      btn.disabled = false;
      delete btn.dataset.busy;
      btn.textContent = "add to profile → PR";
    };

    const current = await fetchFullFile(path);
    if (current == null) {
      restoreBtn();
      composerResult(`couldn't load <strong>${escHtml(path)}</strong> — chip copied instead; paste it into <strong>${field}</strong> by hand. <button type="button" class="qd-link" data-qd-profile>open profile →</button>`, "error");
      try { await window.api?.clipboardWrite?.(chip); } catch {}
      composer.querySelector("[data-qd-profile]")?.addEventListener("click", () => {
        closeAll();
        jumpTo("profile");
      });
      return;
    }

    const patched = appendChipToFrontmatter(current, field, chip);
    if (patched.unchanged) {
      restoreBtn();
      composerResult(`already on your profile — <strong>${field}</strong> lists this chip.`);
      return;
    }
    if (patched.error) {
      restoreBtn();
      composerResult(`${escHtml(patched.error)} — chip copied; add it to <strong>${field}</strong> by hand.`, "error");
      try { await window.api?.clipboardWrite?.(chip); } catch {}
      return;
    }

    if (btn) btn.textContent = "opening github…";
    // GitHub /edit/ URLs can't prefill content — the replacement file
    // rides the clipboard, same as the board's ask status updates.
    let copied = false;
    try {
      if (window.api?.clipboardWrite) {
        const r = await window.api.clipboardWrite(patched.text);
        copied = !r || r.ok !== false;
      }
    } catch {}
    const launched = await launchPRFlow({ kind: "edit", path, value: patched.text });
    if (!launched.ok) {
      restoreBtn();
      composerResult(`<strong>fork first</strong> — once your fork exists, submit again. your chip is kept.`, "error");
      return;
    }
    drafts.delete(leaf.id);
    if (btn) {
      delete btn.dataset.busy;
      btn.textContent = "chip ready ✓";
    }
    composerResult(`
      <strong>github opened</strong> — ${copied ? "paste (it's on your clipboard)" : "copy the file below, paste it over"}, commit, PR.
      <button type="button" class="qd-link" data-qd-reopen>reopen editor</button>
      <details class="qd-result-preview"><summary>replacement file</summary><pre>${escHtml(patched.text)}</pre></details>
    `);
    composer.querySelector("[data-qd-reopen]")?.addEventListener("click", () => {
      try { window.api?.openExternal?.(launched.url); } catch {}
    });
    root.classList.add("qd-sent");
    setTimeout(() => root.classList.remove("qd-sent"), 2000);
  }

  function jumpTo(mode, opts) {
    try { window.__srwkAlchemyJump?.(mode, opts); } catch {}
    document.querySelector(`#primary-nav .alchemy-rail-btn[data-alch-mode="${mode}"]`)?.click();
  }

  // ─── gesture wiring ─────────────────────────────────────────────────

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (uiState === "rest" && dialBlocked()) return;
    e.preventDefault();
    markSeen();
    wasOpenAtPress = uiState !== "rest";
    pressTravel = 0;
    if (uiState === "composing") {
      composingLeaf = null;
      composer.hidden = true;
      composer.innerHTML = "";
    }
    gestureActive = true;
    gesturePoints = [pt(e)];
    root.classList.remove("qd-kbd"); // pointer took over from keyboard
    setState("drawing");
    // Charge ring: a one-shot pulse expanding outward from the press —
    // the wordless "this wants to be dragged" signal. Re-arm per press.
    if (fabRing) {
      fabRing.classList.remove("on");
      void fabRing.offsetWidth;
      fabRing.classList.add("on");
    }
    ctrl.pointerDown(pt(e), fabCenter());
    try { fab.setPointerCapture(e.pointerId); } catch {}
  });

  // Keyboard activation: Enter/Space on the focused FAB produces a click
  // with detail 0 (no pointerdown precedes it). Pointer clicks are already
  // handled by the gesture path above.
  fab.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    if (uiState === "rest" && dialBlocked()) return;
    markSeen();
    if (uiState === "rest") setState("browse");
    else closeAll();
  });

  window.addEventListener("pointermove", (e) => {
    if (!gestureActive) return;
    const origin = fabCenter();
    pressTravel = Math.max(pressTravel, Math.hypot(e.clientX - origin.x, e.clientY - origin.y));
    if (gesturePoints.length < 240) gesturePoints.push(pt(e));
    ctrl.pointerMove(pt(e));
  });

  window.addEventListener("pointerup", (e) => {
    if (!gestureActive) return;
    gestureActive = false;
    try { fab.releasePointerCapture(e.pointerId); } catch {}
    // Classify the full raw trail BEFORE the engine clears its state —
    // a closed circle is the cancel gesture.
    const command = ctrl.state.path.length <= 1 ? classifyGestureCommand(gesturePoints) : null;
    gesturePoints = [];
    ctrl.pointerUp(pt(e));
    afterRelease(command);
  });

  // Press on the scrim closes (a drag RELEASE over the scrim does not —
  // pointerdown never fired there, so no close on gesture end).
  scrim.addEventListener("pointerdown", () => closeAll());

  window.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+Shift+A toggles from anywhere (unless a modal owns the screen).
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "A" || e.key === "a")) {
      if (uiState === "rest" && dialBlocked()) return;
      e.preventDefault();
      markSeen();
      if (uiState === "rest") {
        // Keyboard-opened: bubbles show their 1-9 numerals.
        root.classList.add("qd-kbd");
        setState("browse");
      } else {
        closeAll();
      }
      return;
    }
    if (uiState === "rest") return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Esc inside the custom-tag input only dismisses that input
      if (e.target?.classList?.contains("qd-tag-input")) {
        const row = e.target.closest(".qd-tagrow-custom");
        if (row) row.hidden = true;
        composer.elements.topic?.focus?.();
        return;
      }
      if (uiState === "composing") closeComposer();
      else if (ctrl.state.path.length === 0) closeAll();
      else {
        ctrl.back();
        setState("browse");
      }
      return;
    }
    // Number keys select the nth visible option (tap path, keyboard-only).
    // Gated to fan states so typing digits in the composer never selects.
    if ((uiState === "browse" || uiState === "drawing") && /^[1-9]$/.test(e.key)) {
      const opts = currentOptions();
      const node = opts[Number(e.key) - 1]?.node;
      if (node) {
        e.preventDefault();
        handleNodeClick(node);
      }
    }
  }, true);

  // Positions are corner-derived; a resize invalidates them. Close rather
  // than reflow — reopening costs one tap. Mid-composition we must not
  // throw away the user's typing: the composer is corner-anchored CSS (it
  // survives resize fine), so just flag the fan geometry as stale and let
  // closeComposer resolve it.
  window.addEventListener("resize", () => {
    if (uiState === "composing") staleGeometry = true;
    else if (uiState !== "rest") closeAll();
  });

  // The house hover: the same magnetic pull the tab-bar buttons have
  // (motion.js). The outer button takes the inline transform; the inner
  // .qd-fab-core keeps press/draw scale, so the two never fight.
  magnetize(fab, { strength: 4, dampen: 0.35 });
}
