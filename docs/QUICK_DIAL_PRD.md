# quick dial — PRD + style/function guide

> Status: demo built (2026-06-11). Decisions below are LOCKED; the
> ask branch is fully wired, seek/offer ship demo wiring (see Phase 2).
>
> Base: `@mikeishiring/radial-dial` (C:/Users/micha/Projects/radial-dial)
> Host: Shape Rotator OS (`apps/os`, vanilla-JS Electron renderer)
>
> Shipped in the demo:
> - `apps/os/src/vendor/radial-dial/{geometry,ink,dial-core}.js` — the
>   vendored port (pure JS, zero new dependencies)
> - `apps/os/src/renderer/quickdial.js` + `quickdial.css` — FAB, fan,
>   ink, micro-composer, publish glue
> - `alchemy.js` — four functions exported (`launchPRFlow`,
>   `currentAskContext`, `quoteYaml`, `yamlScalar`); no extraction yet
> - mounted from `boot.js`; CSS linked from `index.html`
>
> Polish pass (2026-06-11, second round):
> - hold-to-draw affordance layer: hover ghost dots along the ring-1
>   angles, press charge-ring pulse, travel-bloom (bubbles fly OUT from
>   the press point), FAB stays compressed while drawing
> - retained-mode ink: drag strokes settle (width relax), click strokes
>   draw in (dashoffset); live stroke trimmed at the active anchor
> - edge-aware ring-2 layout: `fitArcToStage` lays the fan on the
>   largest contiguous in-stage arc (replaces post-hoc clamping, which
>   bunched edge branches to ~31px gaps; now 83px everywhere)
> - house interactions: motion.js `magnetize` on the FAB (same magnet
>   as the tab bar), fp-btn busy/posted submit states, focus-visible
>   parity, chosen-bubble → marker-chip collapse morph
>
> Third round (2026-06-11):
> - seek/offer publish is REAL — frontmatter surgery + edit-PR flow
>   (see decision 7); `quickdial-frontmatter.js` is DOM-free + tested
> - `vendor/radial-dial/gestures.js` ported; circle-scribble = cancel
> - first-run "hold + draw" whisper beside the FAB (dies on first open)
> - "full board ↗" carries the ask draft into the board composer
>   (verb pill, topic, tags), degrading to a no-op if the board
>   markup changes
>
> Fourth round (2026-06-11, cognitive-load pass):
> - ring-1 sub-labels disambiguate the trichotomy at a glance
>   (ask "this week" · seek "want help" · offer "can help")
> - recognition over recall in the composer: ask gets six toggleable
>   tag suggestions (one per vocab bucket); seek/offer turn the chosen
>   bucket's vocab into one-click starters ("agent-runtime: …") that
>   vanish once typing starts
> - keyboard-opened dial shows 1-9 numerals on bubbles (pointer use
>   never sees them)
> - empty-submit nudges the topic field (form is novalidate — the
>   native browser bubble is suppressed in favor of the house nudge)
> - "draft kept" reassurance in the meta line on reopen; post-submit
>   copy tightened to single-action instructions
>
> Fifth round (2026-06-11, membrane calibration — no additions):
> - palette recalibrated from oxide/fork-prompt to the MEMBRANE: mist
>   inks, ember accent with the .18/.35/.55 border-alpha ladder + bloom
>   glows, translucent card gradients, blur(6px) saturate(1.1)
> - composer = the membrane panel in miniature: 16px radius, ember
>   bezel, stacked inset/bloom shadows, asymmetric TL/BR corner
>   brackets (the membrane's signature mark)
> - labels switched to the membrane dock voice: uppercase mono 10px at
>   0.16em; homed bubble = the membrane's aria-pressed state scaled by
>   aim confidence
> - surface-STATE transitions (border/glow/color) ride the membrane
>   curve — 240ms cubic-bezier(0.65, 0, 0.05, 1); spatial motion keeps
>   the dial grammar (expo/overshoot, bloom stagger tightened 42→30ms)
> - caption copy shortened ("draw, then release" / "click — or hold +
>   draw"); fixed a dead selector so the verb leaf crumb actually
>   fills with its board hue
>
> Sixth round (2026-06-11, galaxy + gesture completion):
> - TWO GESTURE FIXES (both upstream-worthy for the radial-dial repo):
>   (1) high-polling mice (1000Hz) starved the outward-coherence gate —
>   per-event deltas were sub-pixel, so drag commits never fired;
>   rawHistory is now distance-sampled (≥3px), making the engine
>   event-rate-invariant. (2) release-commit: lifting the button while
>   clearly aimed at a child commits it (≥56px travel + within the
>   angular cone) — "draw, then release" is now literally true at any
>   depth, regardless of mid-drag gate behavior.
> - bubbles are now membrane-galaxy ORBS: glowing cabochons (radial
>   gradient + bloom, no card/border/blur) with labels BELOW, hues
>   straight from BLOB_PROFILES — ask=asks-amber, seek=cohort-lapis,
>   offer=events-jade; ring-2 inherits its branch hue (one color per
>   branch = always know where you are); path markers tinted to match
> - the FAB is a miniature SELF blob (oxide cabochon) — you, expressing
> - ink end-trims reach the orb rim (constellation-edge look)
>
> Seventh round (2026-06-11, feel + joy):
> - FIXED the "floating bar": the active path marker was a labeled pill
>   hovering in space — now a small glowing waypoint orb (branch hue);
>   the ring's color + caption carry "where am I"
> - the homed orb LEANS toward the cursor (18% × confidence, 12px cap)
>   and the live ink tip bends toward it (applyMagneticPull, ported) —
>   the dial reaches back
> - orbs idle-float (±2.5px, 5.5s, phase-staggered) like the membrane
>   blobs breathing; scrim is a corner vignette (depth, gaze anchor)
> - caption micro-fades on change; composer contents cascade in
>   (30-130ms stagger); post-submit = green glow + one overshoot pulse
>   on the self orb
> - all new motion in both reduced-motion gates
>
> Eighth round (2026-06-11, reach-to-grab + composer chrome):
> - PROXIMITY GRAB: touching an orb mid-drag (≤34px) commits it outright
>   — no release, no gates. Required a matching hysteresis: an undone
>   node holds (uncommittable) until the cursor leaves its zone, or
>   commit ↔ undo oscillates (caught by the test suite, fixed in core)
> - composer corner brackets REMOVED — at miniature scale they read as
>   stray squares, not as the membrane mark
> - composer gained a × (top-right, closes the dial; Esc still walks
>   back a level; crumbs pop to a specific one)
> - FAB membrane-life: a breathing halo on its own layer (never fights
>   press/hover shadows), hover scale, and the + spins a quarter-turn
>   on hover — alive, still a +
> - suggestion rows are open sets: a dashed "+" pill at the end of both
>   rows reveals a small input beneath — Enter mints a pressed custom
>   tag pill (ask) or becomes a custom topic stem (seek/offer); custom
>   tags survive draft round-trips (pills re-mint from the kept field);
>   Esc inside the input dismisses only the input
>
> Ninth round (2026-06-11, search rail + liquid glass):
> - the "empty floating bar" report = the composer's topic input reading
>   naked because the panel's old glass (blur 6, card alphas ~0.55) was
>   invisible against the pure-black void. Fixed by the glass upgrade —
>   the panel now has unmistakable presence
> - SEARCH is the fourth ring-1 orb (starlight grey, straight-left slot
>   at -177°; corner-arc insets tighten for 4+ options). Committing it
>   morphs a glass search rail out from behind the FAB, leftward
>   (width 0 → 420px, expo-out); Enter hands the query to the find
>   overlay via a new find.js export `openWithQuery` (Ctrl+F's engine)
> - liquid-glass pass: composer + search rail use blur(18px)
>   saturate(1.4), white-alpha borders, inset specular top-light, and a
>   sheen gradient across the panel's upper face; inputs are glass
>   (white 4.5% fill + inner highlight) instead of black wells
> - number-key selection gated to fan states so typing digits in the
>   search rail or composer never selects bubbles
>
> Tenth round (2026-06-11, the shape rotator):
> - the base anchor is a CUBE (iso-projected SVG in the self-blob
>   palette) that ROTATES into the chosen branch's solid — live while
>   aiming at ring 1, held while its ring is open, cube again at rest
>   (data-branch attr + crossfade-rotate morph, 320ms expo)
> - every branch owns a SOLID, not just a hue: seek=sphere,
>   ask=octahedron (diamond), offer=hexagonal prism, search=lens
>   (rounded square); ring-2 and path markers inherit the branch shape.
>   Faces are clip-path'd ::before layers; glows are drop-shadow on the
>   unclipped wrapper so they follow each silhouette
> - the scrim is a corner LENS: darkening + blur(14px) live in a
>   ~700px radial falloff from the FAB corner (mask-image on the
>   backdrop-filter element) — the rest of the page stays readable;
>   the element still spans the screen so press-anywhere dismisses
> - instant through-draw (prev round) + shapes verified live with the
>   hidden-window freeze-proof probe technique

## the ask

A `+` button in the bottom-right corner of the OS. Press it, draw a
line, release — and you've expressed an **ask**, a **seek**, or an
**offer** to the cohort in seconds. The radial-dial marking-menu is the
gesture engine; the OS's existing asks pipeline is the publish rail.
This is a comms instrument: the point is reducing the cost of saying
"I need a thing" or "I have a thing" from a form-filling session to a
flick of the wrist plus one typed line.

```
press +  ▶  draw to ASK  ▶  draw to 🤝 pair on  ▶  release
                                                     │
                              micro-composer: one topic line + tags
                                                     │
                              submit → buildAskMarkdown → PR flow
```

---

## what exists today

### radial-dial (the template)

A React marking-menu component, `v0.1.0`, already extracted as a
package. Press the root, drag toward an option to commit, keep drawing
to commit the next level. Tap also works. The relevant anatomy:

- **Gesture engine** — `useRadialDial.ts` (705 LoC). React-coupled
  (useState/useRef), but the actual commit/undo state machine lives in
  the `onPointerMove` body (lines ~232–375) and is extractable: three
  phases (`idle → drawing → committed`), velocity-aware commit
  thresholds, outward-coherence check (>60% of recent motion must be
  outward), angular alignment + lane dominance, hysteresis re-arm on
  undo.
- **Pure modules, framework-free already**:
  - `geometry.ts` (207 LoC) — all tokens: `OPTION_DIAMETER 112`,
    `ACTIVE_DIAMETER 68`, `FAN_RADIUS 224`, `COMMIT_DISTANCE 174`,
    the three easings, spring configs, `velocityCommitFactor`,
    alignment-strength helpers.
  - `ink.ts` (207 LoC) — Catmull-Rom stroke smoothing,
    `inkFullPath()` → SVG path string, velocity → stroke width.
  - `gesture-commands.ts` (74 LoC) — circle/line gesture recognition.
  - `themes.ts` — theme = `{ paper, ink, accent, serif, mono, mode }`,
    everything else derived via `color-mix()`.
- **`placeChildren()` is pure** and already supports `flowMode`
  variants (`radial | right-flow | left-flow | down-flow`). A
  corner-anchored quarter-fan is a trivial fifth mode — the function
  doesn't assume a full circle. `clampToStage()` already exists for
  edge clamping.
- **Rendering** — SVG paths + divs + framer-motion (springs,
  AnimatePresence, LayoutGroup). This layer does NOT port; it gets
  rebuilt small in vanilla.

### shape rotator OS (the host)

- **Vanilla JS, raw ES modules, no bundler, no React.** Renderer
  modules under `apps/os/src/renderer/`, importmap in `index.html`,
  vendored deps under `src/vendor/` (the existing pattern:
  `vendor/shape-ui`, `vendor/js-yaml.mjs`).
- **Asks already exist** as a first-class record type:
  - `cohort-data/asks/*.md` — frontmatter `record_id, record_type: ask,
    posted_at, author, verb, topic, skill_areas, status
    (open|claimed|done), claimed_by`.
  - `renderer/asks.js` — DOM-free shared logic: 5-day expiry, status,
    freshness sort, identity resolution (`isAskMine`), and
    `ASK_VERB_ICONS` — six verbs with per-verb hue pairs:
    🤝 pair on · 🎨 need 30 min with · 🔬 brain on ·
    🧪 try this with me · 📣 looking for · 🪛 help me debug.
  - `alchemy.js` `renderAsks()` (~line 9532) — board + a `<details>`
    composer (verb pills → topic textarea → tags → "submit → open PR").
    Publish = `buildAskMarkdown()` → clipboard + `launchPRFlow()`
    (GitHub fork/PR against `cohort-data/asks/<record_id>.md`).
  - Entry hook already exists: `setAlchemyMode("asks",
    { openComposer: true })` (alchemy.js:1322).
- **Seeking/offering are schema fields**, not a new concept:
  `cohort-data/schema.yml:56-57` — person `seeking` ("verb-first 'I
  want help with X' chips") and `offering` ("'I'd happily be DM'd
  about X' chips"); same pair on teams (lines 144-145). Edited today
  via the profile PR flow (`vendor/shape-ui/profile-form.js`).
- **Comms surface** — there is no chat transport in-app. Comms = the
  asks board (async matchmaking), DM links on ask cards, and the PR
  rail. Hermes is a local Ollama Q&A window, not a messenger. So
  "fast comms" here correctly means: fast *publication of routable
  intent*, not fast messaging.
- **Global-chrome precedent** — sync chip (bottom-left, body-appended,
  `boot.js` `mountSyncChip()`), toasts (top-right, `ux.js`). Tab bar is
  `z-index: 6`; nothing owns the bottom-right corner. FAB mounts the
  same way: body-appended in `boot.js`, idempotent, persists across
  every tab/mode.
- **Design tokens** (`packages/shape-ui/tokens.css`, vendored into the
  OS): abyss `#231F20` ground, paper-cream ink ramp
  `rgba(241,236,231, .94/.74/.52/.32)`, hairline `…,0.14`, oxide red
  accent `--red-1 #8F220E` / `--red-2 #B43A19`, Space Grotesk +
  JetBrains Mono.
- **Motion conventions** — `motion.js` spring (tension 170, friction
  26), `easeOutQuart`, and a **manual reduced-motion override**
  (`html[data-reduce-motion="1"]`) on top of the media query.

### the one real conflict

radial-dial is React + framer-motion; the OS is deliberately
bundler-free vanilla. Three options:

| option | verdict |
|---|---|
| A. mount a React island for the widget | ✗ drags react+react-dom+framer-motion into a no-framework app for one control |
| B. build radial-dial into a web-component bundle | ✗ adds a build step + opaque vendored blob; OS vendors readable source |
| C. **port the grammar, not the library** | ✓ pure modules port nearly 1:1; rebuild the thin render layer in vanilla SVG+CSS |

**Decision: C.** Vendor hand-ported JS versions of `geometry`, `ink`,
`gesture-commands`, plus a new framework-agnostic `dial-core` state
machine, into `apps/os/src/vendor/radial-dial/`. Later (separate
track), upstream that extraction into the radial-dial repo as a
`core/` layer the React hook wraps — that's already the direction of
its roadmap ("from extraction to durable package"), and it keeps the
two projects converging instead of forking.

---

## product spec

### the tree

Ring 1 is the *speech act*; ring 2 is the *flavor*; the leaf opens a
micro-composer. Three options on ring 1 — orthogonal verbs, no
intent overlap:

```
+ (root, bottom-right)
├─ ASK    "I need a thing this week"        → ask record (expires in 5 days)
│   ├─ 🤝 pair on
│   ├─ 🎨 need 30 min with
│   ├─ 🔬 brain on
│   ├─ 🧪 try this with me
│   ├─ 📣 looking for
│   └─ 🪛 help me debug
├─ SEEK   "standing: I want help with X"    → person.seeking chip
│   └─ skill-area buckets (controlled vocab) + "other…"
└─ OFFER  "standing: DM me about X"         → person.offering chip
    └─ skill-area buckets (controlled vocab) + "other…"
```

The ask/seek/offer split maps to data that already exists — ask
records vs. `seeking`/`offering` frontmatter — so the dial is a faster
hand on existing rails, not a new data model. Semantics worth keeping
in microcopy: **asks are ephemeral** (5-day expiry, "this week");
**seeks/offers are standing** profile chips.

Ring 2 for seek/offer uses the `skill_areas` controlled vocab grouped
into ≤6 buckets (e.g. tee/infra, agentic, design, research→product,
bd-gtm, other) — exact bucketing locked at build time from
`schema.cohort_vocab.skill_areas`. Selecting a bucket pre-fills the
chip's tag; the typed line is the chip text itself.

### the three paths

1. **Flick (expert)** — press on `+`, draw through `ask → 🤝 pair on`,
   release. Total gesture <1s. Micro-composer opens with verb locked,
   caret in the topic field. Type one line, Enter → PR flow. The ink
   line, commit-as-you-cross, and drag-back undo come straight from
   the radial-dial grammar.
2. **Tap (discoverable)** — click `+` without dragging: fan opens and
   stays (tap mode). Click options to walk the tree; Esc or click
   scrim walks back/closes. Same `selectChild`/`popToLevel` semantics
   the React component has.
3. **Keyboard** — `Ctrl/Cmd+Shift+A` opens tap mode; arrow keys or
   number keys select; Esc backs out. Registered via the existing
   `registerKeyboardShortcuts()` in `ux.js`. This is also the
   accessibility path — the dial is never the only way (the full asks
   board composer remains).

### the micro-composer (the comms moment)

A small popover card anchored above the FAB (not a modal takeover —
the user keeps visual context of whatever they were doing):

```
┌──────────────────────────────────────────┐
│ 🤝 pair on …                              │
│ ┌──────────────────────────────────────┐ │
│ │ topic — one line, the concrete ask   │ │
│ └──────────────────────────────────────┘ │
│ tags: [tee] [dstack] [+]                  │
│ posting as dmarz · open for 5 days        │
│              [post → PR]  [full board ↗]  │
└──────────────────────────────────────────┘
```

- **Reuses the existing pipeline.** `buildAskMarkdown`,
  `launchPRFlow`, `currentAskContext`, clipboard-copy fallback are
  currently module-private in `alchemy.js` — extract them into a
  shared `renderer/asks-compose.js` (sibling of the already-DOM-free
  `asks.js`) so the dial composer and the board composer cannot drift.
- **Seek/offer variant** writes a chip into the person's
  `seeking`/`offering` list and routes through the same profile-PR
  flow `profile-form.js` uses. One line of text, same posting-as
  footer.
- **Identity guard** — if `authorSlug === "your-slug"` (unclaimed
  profile), the composer renders the claim-your-profile state with a
  link to the profile view instead of a dead submit.
- **"full board ↗"** escape hatch →
  `setAlchemyMode("asks", { openComposer: true })`, carrying any
  typed draft with it.
- After a successful PR launch: toast (existing `ux.js` toasts) +
  the FAB shows a quiet success tick for ~2s.

### what this is not

- Not a navigation menu. The dial expresses intent; it doesn't route
  to views (one escape-hatch link aside). Resist scope creep here —
  a "quick nav" ring is a different feature with different muscle
  memory.
- Not a new message transport. Publication is the PR rail; routing to
  humans stays on the asks board + DM links.
- Not visible during onboarding mode or while a modal dialog
  (`swarm-panel`, etc.) is open.

---

## function guide

### file layout

```
apps/os/src/
├── vendor/radial-dial/          # hand-ported from the package, readable JS
│   ├── geometry.js              # tokens + commit math (port of geometry.ts)
│   ├── ink.js                   # stroke smoothing + SVG path gen (port of ink.ts)
│   ├── gestures.js              # circle/line recognition (port of gesture-commands.ts)
│   └── dial-core.js             # NEW: framework-agnostic state machine
│                                #   createDialController({tree, flowMode, origin, callbacks})
│                                #   → { pointerDown/Move/Up, selectChild, popToLevel,
│                                #       reset, getState() }
│                                #   (the useRadialDial onPointerMove logic, de-Reacted)
└── renderer/
    ├── quickdial.js             # FAB + stage + SVG render layer + micro-composer
    ├── quickdial.css            # all styles (loaded from index.html like intel.css)
    └── asks-compose.js          # extracted from alchemy.js: buildAskMarkdown,
                                 #   launchPRFlow glue, currentAskContext, verb options
```

### dial-core: the port

The React hook's refs/state collapse into one closure-held state
object; `bumpRender` becomes a `notify()` callback the render layer
subscribes to. The state machine is unchanged:

- `idle → drawing` on pointerdown (path seeded with root at origin).
- commit when `dist > commitDistance * velocityCommitFactor(avgV)`
  AND outward-fraction ≥ 0.6 AND alignment/lane-dominance pass —
  these helpers port verbatim from `geometry.ts`.
- drag back inside `undoRadius` pops the path (hysteresis re-arm via
  `armedRef` → `state.armed`).
- `drawing → committed` on pointerup with depth > 0; leaf commit fires
  `onComplete(payload)` → quickdial opens the micro-composer.

### geometry: the corner fan

Add `flowMode: 'corner-fan'` to the ported `placeChildren`:

- origin = FAB center, `(stageW - 44, stageH - 44)`.
- ring 1: arc from 180° (left) to 270° (up), 3 options at
  180°/225°/270°, radius `FAN_RADIUS_CORNER = 168` (scaled down from
  224 — the corner stage is smaller than a full-screen dial).
- ring 2+: reuse the existing deeper-level forward-fan (spread fans
  away from the grandparent direction) + `clampToStage` so six verb
  bubbles never leave the window. With the ring-1 node up-left of the
  corner, the 153° forward fan naturally opens into free screen.
- commit distance scales with the radius:
  `COMMIT_DISTANCE_CORNER = 134` (keeps the 0.8 ratio).

### render layer (vanilla)

- One fixed-position stage div (body-appended, `z-index: 5`, below
  tab-bar's 6) containing: an `<svg>` for ink + a div layer for
  option bubbles + the FAB button itself.
- Ink: `inkFullPath()` already returns an SVG `d` string — set it on a
  `<path>` per frame during drag (rAF-throttled, no per-move layout).
- Bubbles: divs with CSS transitions for enter/exit (no
  AnimatePresence needed — `@starting-style` + `allow-discrete` or a
  tiny enter/exit class pair). The OS `motion.js` spring drives the
  one place a real spring matters: bubble settle after commit.
- Stage is `pointer-events: none` at rest; only the FAB is
  interactive until press, then the stage captures the pointer
  (`setPointerCapture`) for the drag.

### integration points

| hook | where |
|---|---|
| mount | `boot.js`, after `mountSyncChip()` etc. — `mountQuickDial()` (idempotent, body-appended) |
| publish (ask) | `asks-compose.js` → `buildAskMarkdown` + `launchPRFlow` (extracted, shared with the board composer) |
| publish (seek/offer) | profile PR flow used by `vendor/shape-ui/profile-form.js` |
| identity | `currentAskContext()` / `asks.js` identity helpers |
| keyboard | `ux.js` `registerKeyboardShortcuts()` — `Ctrl/Cmd+Shift+A` |
| escape hatch | `setAlchemyMode("asks", { openComposer: true })` |
| toasts | `ux.js` toast on PR-launch success/failure |
| reduced motion | media query AND `html[data-reduce-motion="1"]` |
| visibility | hidden while `body[data-alch-mode="onboarding"]` or any `[aria-modal="true"]` overlay is open |

### build phases

1. **Phase 0 — vendored core.** Port `geometry/ink/gestures` +
   write `dial-core.js`. Pure modules; add a node test file alongside
   (`scripts/` test conventions) for commit math + placeChildren
   corner mode. No UI yet.
2. **Phase 1 — FAB + fan, ask branch only.** Mount, gesture, tap
   mode, ink render, the 6 verbs, micro-composer with topic+tags,
   PR publish via extracted `asks-compose.js`. This is the shippable
   slice — asks are the highest-frequency speech act.
3. **Phase 2 — seek/offer branches.** Vocab buckets, chip composer,
   profile PR flow wiring.
4. **Phase 3 — polish.** Keyboard path, success tick, first-run hint
   (one-time "press and drag" whisper), draft carry-over to the full
   board, gesture-command extras (circle-to-cancel) if they earn it.
5. **Upstream track (parallel, optional).** PR the framework-agnostic
   core + `corner-fan` flowMode into the radial-dial repo; swap the
   OS vendor copy for the package's published core build when it
   lands.

### verification

- `npm run os:dev`, exercise: flick-path post, tap-path post,
  keyboard path, unclaimed-profile state, Esc/scrim close, draft
  carry-over, reduced-motion (both the media query and the manual
  toggle), every tab + alchemy mode (FAB persists, never overlaps the
  sync chip), `npm run check:cohort` after a generated ask file.
- Geometry tests: corner-fan placement stays in-stage at min window
  size; commit thresholds match the package's values scaled by 0.75.

---

## style guide

### theme mapping (radial-dial theme → OS tokens)

The dial's theme contract is one paper + one ink + one accent;
everything derives via `color-mix()`. Filled from `tokens.css`, not
new hexes:

```js
export const SHAPE_DIAL_THEME = {
  name: "oxide",
  mode: "dark",
  paper: "var(--abyss)",                    // #231F20 — stage scrim ground
  ink: "rgba(241, 236, 231, 0.94)",         // --ink-1 cream
  accent: "var(--red-2)",                   // #B43A19 — glow/hover (red-1 too dark to glow)
  // derivations (computed, never hand-specified):
  //   fills:   color-mix(in oklch, accent 8%, transparent)
  //   hover:   color-mix(in oklch, accent 25%, transparent)
  //   border:  color-mix(in oklch, accent 50%, transparent)
  //   glow:    color-mix(in oklch, accent 18%, transparent)
  sans: "var(--font-sans)",                 // Space Grotesk — bubble labels
  mono: "var(--font-mono)",                 // JetBrains Mono — counts, breadcrumb, meta
};
```

- **Ring-2 verb bubbles take their hue from `ASK_VERB_ICONS`** — each
  verb already carries `{ color, light }` pairs and a Lucide-style
  stroke icon. The dial renders the icon + label with
  `--verb-color` exactly as the board does. This is the move that
  makes the dial read as *the same product* as the asks board.
- ask / seek / offer ring-1 bubbles: cream ink on glass
  (`--glass` + hairline border), with a small directional glyph each —
  ask = outward arrow, seek = magnet/in-arrow, offer = open-hand/out —
  accent rim-light on the homed candidate only. One accent, used
  sparingly: the *homed* (about-to-commit) option is the only thing
  glowing at any moment.
- Scrim behind the open fan: `rgba(35, 31, 32, 0.55)` + 6px backdrop
  blur (matches `--glass` language), so the app stays visible but
  quiet.

### the FAB at rest

- 44×44 (not 56 — this app's chrome is dense and quiet; the sync chip
  is the size reference), `position: fixed; right: 20px; bottom: 20px;
  z-index: 5;`.
- Circle, `--glass` fill, hairline border, cream `+` glyph drawn as
  two 1.5px strokes (not a font glyph) — it rotates 45° into a × when
  the fan is open (morph, 200ms expo-out).
- Rest state is *quiet*: no accent, no shadow bloom. Accent rim
  appears on hover (25% mix); `:active` presses to `scale(0.96)`.
- A faint oxide pulse (one slow 4s opacity breath, ±4%) ONLY when the
  user has never opened the dial (first-run discovery), killed
  forever after first open. Honors reduced-motion.

### geometry tokens (corner-scaled)

| token | package | quick dial | why |
|---|---|---|---|
| OPTION_DIAMETER | 112 | 84 | corner stage; labels are 1–3 words |
| ACTIVE_DIAMETER | 68 | 56 | |
| FAN_RADIUS | 224 | 168 | reach ring 2 without leaving a 13" window |
| COMMIT_DISTANCE | 174 | 134 | keep the 0.8 commit/fan ratio — the *feel* constant |
| INK_BASE_WIDTH | 1.6 | 1.6 | unchanged; velocity-width mapping verbatim |

### motion grammar

Keep the dial's own grammar internally — it's the component's
identity — and use OS conventions at the seams:

- **Easings (dial-internal):** entrances expo-out
  `cubic-bezier(0.19,1,0.22,1)`; bubble settle uses the OS
  `motion.js` spring (170/26) instead of porting framer springs;
  overshoot `cubic-bezier(0.34,1.56,0.64,1)` reserved for exactly two
  punctuations: the homed bubble's magnet snap and the post-success
  tick.
- **Asymmetric timing:** fan in 220ms, fan out 140ms. Composer in
  200ms, out 150ms.
- **Ink:** live stroke renders raw during drag; on release the stroke
  settles (340ms, matches package `SETTLE_DURATION_MS`) then the
  whole stage exits with the composer's entrance — the line literally
  hands off to the card.
- **Reduced motion:** fan appears/disappears instantly (opacity-only
  120ms), ink renders as a plain 1.6px line with no width modulation,
  no pulse, no overshoot anywhere. Gate on BOTH
  `prefers-reduced-motion` and `html[data-reduce-motion="1"]`.

### micro-composer styling

- Same card language as the board composer: `--water` panel, 12px
  radius, hairline border, `--t-12` mono for meta ("posting as …
  open for 5 days"), `--t-13` sans for the topic input.
- The committed path renders as a breadcrumb line at the card top in
  mono — `ask ▸ 🤝 pair on` — each crumb clickable to pop back a
  level (mirrors the package's breadcrumb-editing behavior).
- One primary action only ("post → PR", oxide fill, cream text).
  "full board ↗" is a quiet text link, not a sibling button.

### microcopy

- Ring-1 labels: `ask` / `seek` / `offer` — lowercase, house voice.
- Hover/homed whisper line under the fan (mono, --ink-3):
  ask → "this week — expires in 5 days" · seek → "standing — added to
  your profile" · offer → "standing — people can DM you about this".
- Success toast: `ask posted — PR opened in your browser`.

---

## decisions (locked 2026-06-11)

1. **Seek/offer ring-2 buckets** — the six comment-groups already in
   `schema.yml`'s `skill_areas` vocab: tee/trust (tee, dstack,
   attestation, formal-verification) · crypto (zk, post-quantum,
   threshold-crypto, mpc) · agents (agentic, agent-runtime,
   agent-routing) · chain/mev (mev, cross-chain, identity) · infra
   (p2p, durable-workflows, confidential-db) · design/gtm (design,
   bd-gtm, research-to-product).
2. **Teams** — person records only in v1; team posting is a later
   modifier, not a ring.
3. **Draft persistence** — kept in-memory per leaf for the session;
   restored when the same leaf is reopened. Cleared on submit.
4. **apps/web parity** — no. OS-only until the core is upstreamed.
5. **Upstream timing** — port-then-upstream. The vendored copy at
   `apps/os/src/vendor/radial-dial/` is the working source; PR the
   framework-agnostic core + corner flowMode into the radial-dial repo
   as a separate track, then swap the vendor copy.
6. **Reuse over extraction (demo)** — instead of extracting an
   `asks-compose.js`, `alchemy.js` exports `launchPRFlow`,
   `currentAskContext`, `quoteYaml`, `yamlScalar` (four one-word
   diffs). The ask markdown template is mirrored in `quickdial.js`
   from `submitAskCompose` — drift risk accepted for the demo; the
   extraction remains the right Phase-2 refactor.
7. **Seek/offer publish (UPGRADED, third round)** — submit now does the
   real thing: fetches the person file from upstream main, appends the
   chip to `seeking`/`offering` via text surgery
   (`renderer/quickdial-frontmatter.js` — one-line PR diffs, comments
   preserved, inline arrays converted, case-insensitive dedupe), copies
   the replacement file to the clipboard, and launches the edit-PR flow
   (GitHub /edit/ can't prefill, so the clipboard carries it — same UX
   as the board's ask status updates). Unit-tested in isolation;
   degrades to chip-on-clipboard + profile jump when the fetch fails.

## honest critique (current weakest points of this spec)

- The **seek/offer branches are under-specified** relative to ask —
  the chip-composer + profile-PR wiring is asserted, not designed.
  Phase 2 needs its own short spec pass before build.
- **Corner-fan ergonomics are unproven** — a 90° arc with 3 options is
  comfortable, but ring 2's six verbs fanning from a corner-adjacent
  node needs a day-one feel prototype; the clamp math may force a
  tighter spread than the gesture engine's lane-dominance check likes.
  This is the highest-leverage thing to validate first in Phase 1.
- **PR-flow latency** undercuts the "fast" promise — the gesture is
  sub-second but publication still round-trips through GitHub. Honest
  framing: the dial makes *expressing* fast; the rail is unchanged.
  If that lands badly in use, the fix is a queue-and-batch PR model,
  which is a different PRD.
