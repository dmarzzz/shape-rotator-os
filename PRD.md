# PRD — Shape Rotator OS

Succinct log of shipped features. Newest first.

## Custom shader — edit the real orb GLSL (2026-06-18)

Below the dials, the sphere popup has a collapsible **Custom shader** section. It now
shows the **actual orb shader as editable GLSL** — the real `surface()` function (the
kaleidoscope fold loop, turbulence, palette) — so a person can read it, tweak it, and
watch the preview update live. (Earlier iterations shipped a safe single-expression
mini-language; the user wanted to see/edit the literal kaleidoscope, which an
expression-only DSL can't represent, so the editor pivoted to raw GLSL.)

**Safety model + what's live:** raw GLSL *cannot* be made crash-proof for other viewers
(a heavy loop stalls their GPU), so right now custom GLSL renders **only on the author's
own device** (the editor preview), compiled in isolation with fallback. Broadcasting it
cohort-wide is gated on a **GPU cost-sandbox** (bounded-loop GLSL validator + timer-query
watchdog) — a security-critical follow-up, not yet built. The safe expression-DSL below
remains in the tree (dormant) and could back a "safe shared" mode later.

- **Editor (raw GLSL)**: a `<details>` (collapsed; expands **downward**) holding a tall
  GLSL code box **prefilled with the real `surface()` function** ([DEFAULT_SURFACE_GLSL](apps/os/src/vendor/shape-ui/shape-canvas.js)),
  with **GLSL syntax highlighting** (`highlightGLSL` — keywords/types/builtins/comments/
  numbers, HTML-escaped, behind a transparent-text textarea). Edits recompile the live
  preview (debounced); `mountShape`'s `onStatus` surfaces the **real GLSL compile error**
  (`✕ 'oops' : undeclared identifier`) or `✓ compiled`. `userFragGLSL` splices the user's
  `surface()` into the orb template (geometry + lighting + rim stay) and compiles in
  isolation — **any** failure falls back to the standard orb, so a typo never breaks it.
  Engagement-gated (`_shaderTouched`) so a dial-only save never adopts the prefilled
  default. (Clutter note removed — the code IS the documentation.)
- **No blink — program hot-swap**: the blink was WebGL **context churn** (re-mounting
  destroys + recreates a GL context per edit, which flashes the compositor). Fix: the
  preview mounts **once** with `opts.smooth: true` (a persistent preserveDrawingBuffer+EMA
  context); every edit calls `update({ shaderGLSL })`, and `swapShaderGLSL` rebuilds the
  fragment program and swaps it on the **same** context — **zero** new contexts for the
  whole session (probe-verified). The kept buffer EMA-morphs old→new colour in place;
  a failed/blocked compile keeps the current program and reports via `onStatus`. The EMA's
  **first frame also draws fully opaque** (smoothing from frame 2) so the orb never fades
  in from transparent (which let the page show *through* it — the white blink). Editor
  shows nothing on success, only `✕ <error>` on failure.
- **Safety guards** (`glslGuardReason` in both `shape-canvas.js`, reported via `onStatus`,
  run at every render): **max length** (`MAX_GLSL_LEN` = 4000; DB CHECK 8000 backstop),
  ban `while`/`do`/`#`/`gl_*`/`texture`/`sampler`/`texelFetch`/`image*`, **plus a real
  for-loop cost bound** — every `for` must be canonical `for(i=0; i<LITERAL; …){…}` with
  per-loop bound ≤ 256, the **nested product of bounds ≤ 1024** (a brace-scan bounds
  per-pixel iterations regardless of nesting), ≤ 6 loops; `for(;;)`/variable/function-call
  bounds + braceless bodies are rejected fail-safe. So a single frame is bounded → no GPU
  hang/TDR → a shader can't break the computer. Verified by an adversarial loop probe.
  Remaining for *broadcast* (multiple orbs on others' GPUs): a per-frame timer-query
  watchdog + the multi-orb budget.

- **Security boundary** ([shader-dsl.mjs](apps/os/src/renderer/shader-dsl.mjs),
  `compileUserExpr(src) → { glsl } | { error }`): the stored `shader_src` is treated
  as **untrusted** (the shipped anon key can POST any string, bypassing the editor),
  so it is **re-validated on every viewer at render time** — raw text never reaches a
  GL compiler. It is **one expression** (no statements/assignments/loops/blocks/
  preprocessor/comparisons → no infinite loops, no injection); a **character allowlist**
  in the tokenizer (only identifiers, number literals and `+ - * / ( ) , .`) bans
  `; { } [ ] = # …`; an **identifier/function allowlist** (inputs `p n uv t hue warp
  density layers sharp PI`; funcs `sin cos … mix clamp smoothstep vec2/3/4` + bounded
  builtins `noise/fbm/pal/hsv`) with arity checks rejects `gl_*`/`texture`/keywords;
  and **cost caps** (≤1500 chars, ≤256 AST nodes, ≤32 depth, finite bounded literals;
  `fbm` has a FIXED 4-octave loop) bound per-pixel GPU work → no DoS. The GLSL is
  **re-emitted from the validated AST** (never echoed), wrapped `vec3(<expr>)`, and
  compiled in isolation — **any** compile/link failure silently falls back to the
  standard shader. `mountShape` adds a final `/[;{}#]/` guard.
- **Full surface override, built on `base`**: `userFragSrc` (both `shape-canvas.js`
  copies) runs the standard pipeline, exposes its result (the kaleidoscope, lit +
  rimmed) as the DSL input **`base`**, then makes the expression the orb's **final
  colour** (`outColor = vec4(<expr>, u_blend)`). So the default code is literally
  `base` → the exact standard orb; users edit out from there (`base*pal(t)`,
  `base+fbm(…)`) or drop `base` for a fully custom look. (The kaleidoscope is an
  iterative fractal that can't be a single DSL expression — hence the `base` input.)
- **No-flicker (temporal smoothing)**: flash rate is the time-derivative of the colour
  and multiplication amplifies it (`t*99`, `sin(t*big)`…), so it can't be capped in the
  maths. Instead, *animated* custom orbs are smoothed at render time: `preserveDrawing
  Buffer` + `blendFuncSeparate` make each frame an **EMA** toward the new colour
  (`1 - e^(-dt/τ)`, τ≈0.25s) while alpha accumulates to opaque — capping how fast the
  displayed colour can change (a full per-frame strobe → ~5% Δ). The sphere silhouette
  is a constant circle so there are no trails; standard orbs + the static pill are
  untouched.
  (The DSL `base` input + expression highlighter (`highlightExpr`) + the collapsible/
  expand-down popup + engagement-gating all came from this dormant DSL editor and were
  carried over to the GLSL editor.)
- **Storage**: new nullable `shader_src text` column on `os_spheres`
  ([migration 3](supabase/migrations/20260618030000_os_spheres_shader.sql), `CHECK
  char_length ≤ 2000` as defense-in-depth). `saveSphere` sets it when present / clears
  it on empty, and its **progressive retry** drops it (then `bg`) if a column is absent,
  so saves keep working before the migration is hand-applied.
- **Render surfaces (v1)**: custom shaders render via per-canvas **`mountShape`**
  (validated-on-read) in the **editor live preview** (debounced re-validate + re-mount,
  inline ✓/✕ status), the **pill avatar**, and — the "others see it" surface — the
  **detail-page orb** (`renderPersonRail` emits a dedicated `[data-detail-orb]` canvas,
  outside the shared overlay, only when the shader validates; `mountCustomDetailOrb`
  mounts it draggable). The shared-overlay **grid cards** and the **seal avatar** keep
  the standard dials shader (one overlay program can't run per-user GLSL cheaply) — a
  documented follow-up.
- **Verified**: `shader-dsl.test.mjs` (16 adversarial unit tests — statements, loops,
  comments, preprocessor, `gl_*`/`texture`, unknown ids, indexing, assignment, illegal
  chars, bad arity, non-finite, cost caps, never-throws) + `supabase-sphere.test.mjs`
  (shader_src save/clear + progressive retry) green (28 total); smoke boots clean; both
  `shape-canvas.js` copies byte-identical for the shader code; plus a **multi-agent
  adversarial security audit** of the validator. **Requires migration 3 hand-applied**
  (degrades gracefully until then).

## Customize your sphere — esoteric dials + orb colour, saved for everyone (2026-06-18)

A person opens a popup (by clicking their orb avatar), tunes their sphere over a
live preview, presses **save**, and every viewer's app reflects it within seconds.
The look was previously fully deterministic (`hashColors(record_id)`); these
override that per person.

- **Five dials** (one-word sci-fi names; [supabase-sphere.mjs](apps/os/src/renderer/supabase-sphere.mjs)
  `SPHERE_DIALS`): **Chroma** (`u_hue` palette), **Vortex** (`u_warp` —
  multi-octave domain-warp **turbulence**: layered sine octaves churn/billow the
  lattice into chaotic, organic distortion, not a spin), **Lattice** (`u_progress` fold density, widened ~0.6–6.0 piecewise),
  **Strata** (`u_iters` — fractal layer count 1..6 via a dynamic-break loop), and
  **Filament** (`u_sharp` — line sharpness via the `pow` exponent). Defaults reproduce
  the original look exactly so uncustomized orbs are unchanged. To avoid new
  migrations the dials **reuse the existing float columns**: `phase`→Vortex,
  `hue2`→Strata, `intensity`→Filament (the rim glow `u_intensity` is a fixed render
  constant; `u_phase` + `u_hue2` stay hash-derived per person).
- **Instant-save to Supabase**: new `os_spheres` table (one mutable row per person,
  upsert via PostgREST merge-duplicates;
  [migration](supabase/migrations/20260618010000_os_spheres.sql)). Read as a live
  overlay (`applySphereOverlay` in
  [cohort-source.js](apps/os/src/renderer/cohort-source.js), beside the evidence/
  article overlays) onto `surface.person_spheres`; the card/detail/preview
  renderers stamp it onto each `<canvas>` via `sphereAttrs()`.
- **Orb Core colour** ("Orb Core" picker): replaces the orb's dark canvas/background
  colour `K_CANVAS` with the chosen colour at **full strength** (`col = u_bg` when
  set, kaleidoscope on top) — so the whole orb body reads as that colour, not a
  faint tint (the earlier `u_bg*0.4` was the bug). The region **outside** the orb
  is ALWAYS transparent — never a box behind it (the standalone `mountShape` uses an
  alpha context + clears transparent + blends, like the overlay). Picked from a
  curated **10-colour muted palette** (`SPHERE_BG_PRESETS`, one row) **or a hex
  field** — the full-spectrum native colour picker is deliberately not exposed.
  Stored in the `bg` column
  ([migration](supabase/migrations/20260618020000_os_spheres_bg.sql));
  `saveSphere` retries without it if absent.
- **Avatar = your sphere; click-to-edit popup** ([alchemy.js](apps/os/src/renderer/alchemy.js)
  `openSphereEditor`, [identity.js](apps/os/src/renderer/identity.js)): the bottom-left
  pill + the "your seal" card render your orb as the avatar — **bare** (no container
  background/border). The seal-card orb is **1.5× larger** (90px, negative margins so
  it fills the row's empty space without growing it; no hover effect). The **pill orb is STILL**
  (`mountShape` `animate:false`) and clicking the pill opens the **profile page**;
  editing happens by clicking the orb in the "your seal" card, which opens the modal.
  The modal has **no close button** (click-outside / Esc dismisses), **no sub-hint
  text**, an enlarged ~260px preview that is **drag-to-rotate** (quaternion fling +
  idle tumble ported into `mountShape` via `opts.draggable`, matching the detail
  page), and **save + status pinned bottom-right**.
- Note: identity is unverified (no auth), so `os_spheres` is technically writable
  for any record_id — documented in the migration; member auth is the eventual fix.
- Verified: `supabase-sphere.test.mjs` (clamp / hex / upsert body+headers / bg
  retry / graceful degrade) green; renderer smoke test boots clean. **Requires
  BOTH migrations hand-applied to Supabase** (like `os_feedback`) before saves land.

## Shareable deep-links — `https://…/s/xxxxx` → `sros://` (2026-06-16)

Copy a link to any page and send it; clicking it on a machine with the OS
installed launches (or focuses) the app and lands on that exact page.

- **Two forms, one 5-char code** ([share-link.js](apps/os/src/renderer/share-link.js)):
  the OS registers the custom scheme `sros://xxxxx`, but chat/email/notes apps
  only auto-linkify `http(s)`, so the **copy action emits a clickable https
  link** — `https://os-web.shaperotator.xyz/s/xxxxx` — that a tiny redirect page
  bounces into `sros://xxxxx`. `parseLocation` accepts both forms. A code is
  `hash5(stable-id)` — a view's internal structural id, or a record's
  `record_id` slug — never a title or content, so a link survives page renames
  and edits. The hash + canonical-key strings are a **frozen wire format**;
  an append-only `VIEW_ALIASES` table lets an internal view rename keep old codes
  resolving. The ~27 fixed views are asserted collision-free; records hash at
  load time (rare collisions are logged, per the chosen runtime-hash design).
- **Redirect page** ([apps/web/s.html](apps/web/s.html) + `vercel.json` rewrite
  `/s/:code → /s.html`): reads the code, forwards to `sros://`, offers a download
  fallback. Ships with this repo's web app (`os-web.shaperotator.xyz`), which the
  link base points at, so clicked links resolve once the web app deploys.
- **Reuses existing nav**: serialize = `navSnapshot()` → code; apply = code →
  `navApplyLocation()` / `__srwkAlchemyShowRecord` (the same path the mouse
  back/forward buttons and find.js use). The code↔page index is built from the
  cohort surface and refreshed on dataset change.
- **Share triggers**: a "Copy link to this page" command-palette entry plus a
  floating button pinned to the window's bottom-right corner (hidden on the
  matrix tab; flashes the brand yellow on click; no toast — copies silently).
- **Delivery** ([main.js](apps/os/main.js) + [preload.js](apps/os/preload.js)):
  `setAsDefaultProtocolClient("sros")`; macOS via `open-url`, Windows/Linux via a
  non-darwin single-instance lock + `second-instance` (macOS instance behaviour
  unchanged) and cold-launch argv. Links that arrive before the renderer is ready
  are queued and drained via `deep-link:get-pending`. Scheme registered for
  packaging through electron-builder `build.protocols`.
- Verified: encoder round-trips both forms + 5-char/uniqueness/garbage-no-op
  checks, renderer bundles (77 modules) and boots clean (smoke test). The OS
  click→open round-trip needs a packaged build + the redirect page live.

## Membrane: hidden Rubik's-cube easter egg (2026-06-15)

A playable Flashbots Rubik's cube hides at the end of the membrane die's shape
cycle. Spin the centre shape fast to morph it; after every regular shape has
been shown (d20 → d12 → d8 → d7 → d6), the next fast spin reveals the cube
instead of wrapping. Spin the revealed cube fast again to cycle back to the
shapes.

- **Self-contained module** ([rubiks.js](apps/os/src/renderer/membrane/rubiks.js)):
  a direct port of the standalone cube (`rubiks-cube-web/`) — its own renderer,
  lights, RoomEnvironment, NeutralToneMapping and two-pass layer-selective bloom,
  plus all the tuned plastic colours, inverted-normal fixes and gated feature
  glows (white X / blue eyes / yellow bolt). It renders to its **own transparent
  canvas** overlaid on the die (`.membrane-rubiks-canvas`); reconciling it into
  the membrane's ACES/threshold-bloom scene would have wrecked those colours.
- **Fully playable**: drag a cubie face to turn that layer (short drag past ~15°
  commits a quarter turn), drag empty space to orbit. **Scramble + Reset** buttons
  fade in under the cube (Reset animates the inverse-move replay). When untouched
  the cube does a slow idle camera-orbit so it tumbles "like the other shapes".
- **Sized to match the die**: the cube renders with the die's exact camera (fov
  `MEMBRANE_FOV` + look-at distance `MEMBRANE_CAMERA_Z`, exported from scene.js)
  and its 3×3 body edge is scaled to the die's d6 edge
  (`TARGET_R · 2/√3 · CUBE_SCALE`), so it reads the same on-screen size as the
  cube shape it replaces. Zoom is locked (`noZoom`) so it stays that size.
- **Glow gated strictly by emissive (no reflection leak)**: the selective-bloom
  pass blanks each glow mesh's albedo to black but kept the `MeshStandardMaterial`,
  so `scene.environment` still lit it **specularly** — that reflection bloomed
  independently of emissive, leaving a feature faintly glowing even when its glow
  was gated off (e.g. the X with the back face unsolved). Fixed by nulling
  `scene.environment` for the duration of the bloom pass (restored for the final
  pass), so the bloom captures ONLY emissive. Now glow strictly follows the gate:
  emissiveIntensity 0 ⇒ zero bloom. Applied to **both** the membrane module and the
  standalone (`rubiks-cube-web/index.html` + regenerated `rubiks-cube-standalone.html`).
- **Cube interaction = camera-orbit (object stays at identity)**: an attempt to
  make the cube rotate as an OBJECT (to match the die's spin/inherit it on reveal)
  was REVERTED — rotating the cube tumbled its faces through the fixed lights, so
  the tuned face colours shifted with orientation, and it complicated layer-turn
  dragging. The cube stays at identity and the **camera orbits** (TrackballControls)
  for the idle tumble + free spin; a sustained-fast background spin still fires
  `onCycleAway` to return to the shapes. This keeps lighting fixed relative to the
  cube (stable colours) and the layer-turn drag math in world == cube-local space.
  Kept from that pass: `releasePointerCapture` guarded in try/catch (can't abort a
  turn's finalize), and the cube body sized to the die's d6 edge **× 1.2** (20%
  larger, by request).
- **Reset does the minimal turns**: instead of replaying every recorded turn, the
  move history is collapsed first (`reduceMoves`: merges consecutive same-layer
  turns, cancels turn-and-turn-back, cascading). The reduced sequence has the same
  net effect, so its inverse still solves it — in far fewer turns when the play had
  redundancy. (Both versions. Note: a fully-random scramble has little redundancy,
  so those turns are genuinely needed; this isn't a from-scratch optimal solver.)
- **X keeps a 30% glow floor**: the back-X glow never drops to 0 — it holds a
  constant 30% (uniform emissive wash) when unsolved and ramps to 100% when the X
  is assembled. The even wash masks any residual paint-shade mismatch on the back
  cubies. (Both versions; eyes/bolt still gate 0→100%.)
- **X paint shades consistently (inverted-normal fix)**: several back cubies ship
  with inward-pointing `Vit_X` normals (the same model defect that washed out
  other colors), so the white X paint shaded a *different color* on those pieces
  ("some X parts white, others gray" when the X isn't assembled). The original
  `NORMAL_FIX_CUBIES` pass deliberately excluded `Vit_X`; now the flat X gets the
  same per-vertex outward-normal correction (`dot(normal, position) < 0` → flip)
  on every back cubie. Verified: all 9 X pieces now have uniform outward normals
  (0 inward) → consistent shading. Applied to both the membrane module and the
  standalone (+ regenerated single-file).
- **Clean back-face "X" glow**: the white X glows ONLY when the full back face is
  assembled (gated on all 9 back cubies solved), and only the X stroke itself
  glows. The model's white shells wrap onto the cubies' side/front faces, so every
  back cubie's shell is split per-triangle — only the **outermost (most-negative-Z)
  back wall** glows; the inner wall, side walls, and the rest stay matte white.
  Selecting by position (plus `|normal.z| > 0.5` to drop side walls) rather than by
  normal direction matters because several back cubies ship with inverted normals
  (model defect) — a normal-only test glowed their inner wall, leaving the visible
  outer wall matte and depth-occluded from rear views (one corner read dim). Now all
  four corners glow symmetrically from any angle, with no glow bleeding through the
  body from the front. (Previously corners glowed their whole shell, leaking white
  onto non-X faces whenever the back happened to be assembled.)
- **Gating** ([scene.js](apps/os/src/renderer/membrane/scene.js)): the scene
  counts morphs since boot; once all shapes are seen it fires `onRubiksReveal`
  (suppressing further die morphs). The cube's own sustained-fast background spin
  fires `onCycleAway` → `resumeFromRubiks()`, which morphs the die on into the
  next shape. Reveal/hide cross-fades the two canvases via a `membrane-rubiks-active`
  class ([membrane.css](apps/os/src/renderer/membrane/membrane.css)); the module
  is built lazily on first reveal (no cost until then).
- **Uncompressed model**: the OS app's CSP forbids the blob-URL worker three's
  `DRACOLoader` needs, so the bundled `rubiks_cube.glb` is **Draco-decoded** to a
  plain GLB (built offline by
  [decompress-glb.cjs](rubiks-cube-web/decompress-glb.cjs) using the Draco decoder
  that ships with three) and loaded worker-free with plain `GLTFLoader`. The
  standalone keeps its small Draco file.

## Membrane: light mode support (2026-06-13)

- The membrane page was dark-only; it now follows the app's `html[data-theme="light"]`
  toggle. **Dark mode is unchanged** — every change is gated on the theme, read once at
  scene mount (`getTheme()` in [scene.js](apps/os/src/renderer/membrane/scene.js); the
  toggle lives on the profile page so the scene always remounts with the right theme).
- **CSS** ([membrane.css](apps/os/src/renderer/membrane/membrane.css)): host background →
  paper, the cream ink triple tokenized as `--mem-ink-rgb` (dark mode resolves to the
  identical value) and flipped to near-black in the light block, panels → light glass,
  reading-gutter scrim + throne glow + "enter field" pill lightened.
- **WebGL** ([starfield.js](apps/os/src/renderer/membrane/starfield.js),
  [cube.js](apps/os/src/renderer/membrane/cube.js)): additive blending is invisible on
  white, so light mode switches stars + cube edge-lines to **normal blending**. Stars use
  a faint pale palette (barely-there on white per request) and the additive nebula mist is
  dropped. The cube stays vivid (body shader untouched) but its rim/edges are driven from
  the darker domain `baseColor` so the wireframe reads on white. Bloom is tuned down in
  light mode (threshold 0.80 / strength 0.40) so the body doesn't wash the page.
- **Light-mode polish**: the membrane field is now a touch DARKER than the feed/
  agenda cards (radial `#efefef→#e2e2e2`, won via a higher-specificity selector over
  the generic `.alchemy-canvas` bg rule) so cards read as white cards. Feed kind
  tints + agenda category colors are darkened to readable hues in light mode (the
  pale sage/lapis/amber/teal pastels washed out on white); cards go near-white.
- **Hover glow now blooms**: hovering a face drives a bright emissive from a new
  `uGlowColor` uniform (the bright rim pastel, both themes) at HDR gain 1.6, so the
  hovered facet crosses the UnrealBloom threshold and the pass throws a real colored
  halo instead of just a brightness bump. (Dark-mode hover also blooms harder now.)
- Transcript feed chips remain hidden (separate parked item). The full calendar TAB
  (calendar.css) still lacks light-mode category colors — separate follow-up.

## Membrane: agenda rolls forward to upcoming days (2026-06-13)

- The right-edge agenda no longer reads blank on a quiet today. It keeps the
  today time-axis + glowing now-line **only when today has timed events**;
  when today is empty it skips the tall empty axis and leads with a
  look-ahead list (the "empty day" problem — Apple "Up Next" / roll-forward
  model, per research on Google/Fantastical/widget patterns).
- **Unified with the left feed.** Every agenda item — today's all-day items
  AND upcoming events — is a card with the same chrome as the left feed item
  (1px border, 9px corners, ~53px tall, 2-line: title over a sub like the
  time or "all day"). No "TODAY" header. Grouped under weekday-name + date
  headers (e.g. "SUN JUN 14"). The today time-axis + now-line is still used
  when today actually has timed events.
- **Clickable** — each agenda card is a button that opens the calendar in a
  new OS tab (`window.__srwkOpenInNewTab`), like clicking through from the
  calendar view. The agenda sits at z-index 2 (above the canvas) with the
  container passing pointer events through and the cards opting back in.
- Card titles WRAP (no truncation) — a long event name flows onto a second
  line and the card grows, rather than clipping to "…".
- **Category color + contrast** — cards carry the calendar's category tint
  (`data-cat` → `--c2-acc`, same hexes as calendar.css) at ~20% fill / 38%
  border, giving more contrast against the dark stage than the flat neutral.
  Day headers are ~30% brighter (0.34 → 0.44 alpha) for legibility. Built by a new `eventsUpcoming` in
  `computeMembraneData()` ([alchemy.js](apps/os/src/renderer/alchemy.js)) from
  the same two sources as `eventsToday` — calendar GRID cells (new
  `upcomingGridEvents()` over the next ~4 weeks) + cohort event spans —
  deduped by title across the window (recurring spans surface once), skipping
  today's items, day-ordered, capped at 10. Day labels are recomputed from
  each item's date at render time so they don't go stale overnight.
  [membrane/index.js](apps/os/src/renderer/membrane/index.js) renders the
  block below the track; the agenda is now a flex column so the track yields
  room. Width unchanged (190px). Today behavior/constants/now-line untouched.

## Membrane: clickable "what's new" feed on the left edge (2026-06-13)

- **Left-edge activity feed** mirroring the right-edge agenda. A recency-
  sorted, color-coded stream of cohort activity as small two-line cards
  (color rail + label + meta + relative age), scrollable, no header text:
  - **release** (green) — per-project GitHub activity, expanded from each
    weekly summary into its individual example commit subjects (incl.
    shape-rotator-os)
  - **transcript** (lapis) — newly-distilled session readouts
  - **ask** (amber) / **event** (jade) when present
- Each item leads with a per-kind Lucide icon (same set as the rail/tabs) so
  the type reads at a glance — github / file-text / message-circle / calendar
  for release / transcript / ask / event. Icon AND the project/kind chip share
  one per-kind tint (sage / lapis / amber / teal) at a softened saturation —
  clearly colored but dialed back from the original loud green. Transcripts
  are dated by their git-added (upload) date, not the older session date, so
  newly-distilled readouts surface as fresh.
- **Clickable** — each card opens that thing in a NEW OS tab via
  `window.__srwkOpenInNewTab()` (new hook in [tabs.js](apps/os/src/renderer/tabs.js)):
  a release opens its project (cohort detail), a transcript opens the
  context/transcripts view, an ask opens asks, an event opens the calendar.
  The feed sits above the canvas (z-index 2) on the left edge so it's
  interactive without blocking the centered cube.
- **Build-time generation**: the feed is generated by `buildWhatsNew()` in
  [build-bundles.js](scripts/build-bundles.js) and bundled into the surface
  as `whats_new` (expands github example commits, transcripts, asks, recent
  events; date-sanity filtered; cap 60). [cohort-source.js](apps/os/src/renderer/cohort-source.js)
  sources it preferring main's copy but falling back to the bundled fixture,
  so the feed reads full even before the rebuilt surface ships to main.
  [alchemy.js](apps/os/src/renderer/alchemy.js) prefers `c.whats_new`, with a
  live `buildWhatsNewFeed()` fallback. Also: build-bundles no longer gates
  GitHub artifacts on `review_status: reviewed` (deduped per project/week,
  reviewed copy preferred). Requires `npm run build:cohort`.

## Membrane "what's new" feed: live via Supabase + full-history backfill (2026-06-19)

The release feed no longer depends on a git PR merging into protected `main` —
which had frozen it at v0.3.5 (the `github-releases-sync` automation branch was
pushed hourly but its `gh pr create` silently failed without the repo's "Allow
GitHub Actions to create pull requests" setting, so nothing advanced `main`).
The feed now follows the SAME live-source / offline-bundle split as the calendar:

- **Live source**: [`scripts/publish-releases-to-supabase.mjs`](scripts/publish-releases-to-supabase.mjs)
  upserts `{ whats_new, github_releases }` to the `public_releases_feed` row
  (migration [`20260619000000_public_releases_feed.sql`](supabase/migrations/20260619000000_public_releases_feed.sql),
  anon-read / service-role-write, mirroring `public_calendar_grid`). Runs as a
  new step in [`github-releases-sync.yml`](.github/workflows/github-releases-sync.yml)
  using the service-role secret the calendar workflow already holds — no PR, no
  merge, no admin setting required.
- **Read overlay**: [`supabase-releases.mjs`](apps/os/src/renderer/supabase-releases.mjs)
  reads the row anonymously; `applyReleaseOverlay()` in
  [`cohort-source.js`](apps/os/src/renderer/cohort-source.js) folds it onto the
  surface next to the evidence/article/sphere overlays. The committed
  `cohort-surface.json` stays the offline / first-paint fallback.
- **Backfill**: the live payload carries the FULL in-window release history per
  project (cap 100), not the committed bundle's `PER_PROJECT_RELEASE_LIMIT = 12`.
  This restores ~60 previously-missing shape-rotator-os releases (the whole
  0.1.x/0.2.x May history) so the feed reads as the complete program log.
- The `public_releases_feed` migration must be hand-applied in Supabase before
  the publish step writes (else the upsert 404s), same as the other OS tables.

## Membrane: psychedelic cube replaces the blob cluster (2026-06-12)

- **The 4-orb blob cluster in the lower-right is gone.** In its place: one
  slowly tumbling cube dead-center of the stage
  ([cube.js](apps/os/src/renderer/membrane/cube.js)) —
  liquid iridescent surface (trig domain-warp through an IQ cosine palette,
  texture-free), additive glowing edges, and a counter-rotating inner wire
  cube. The fresnel rim + edges feed the existing bloom pass.
- **Interaction model preserved**: footer dots switch the active domain
  (self/cohort/events/asks) — the cube TINTS toward that domain's colors
  instead of orbs swapping slots. Clicking the cube opens the active panel;
  clicking the void folds it away. Orbital name ring still rides the anchor.
- **Grab it**: drag anywhere on the canvas to spin the cube (screen-space
  arcball, premultiplied quaternion), release mid-swipe for fling momentum
  that eases back into the idle tumble (~2.5s). Cursor: grab/grabbing.
- **Speed → brightness**: the scene measures the cube's actual per-frame
  rotation (quaternion `angleTo`), maps speed-above-idle into a 0..1 energy
  uniform, and the shader lifts the whole surface (and edge glow) above the
  bloom threshold — so the faster you spin/fling it the more it blazes, and
  it sits at default brightness at rest. Energy ramps up fast (0.25/frame)
  and coasts down slow (0.06/frame) so the glow trails the motion.
- **Spin-to-morph the die**: it boots as the **d20** and changes shape when
  you spin it fast — it must stay above the trigger speed for ~0.5s
  (sustained, not a single fast frame), then a hysteresis latch fires one
  morph per fast burst (spin must slow back down to re-arm), so you can land
  on a specific shape.
- **Click to stop**: clicking the cube halts it instantly (zeroes the spin)
  and it stays still; clicking an already-stopped cube does nothing.
  Dragging it revives the motion (and the idle tumble afterward). Void-click
  toggles the panel. Per-frame dt is clamped so a backgrounded tab can't
  blow up the spin physics.
- **Shape roster** (`ALLOWED_FACES`, cycled in order with wraparound): cube
  (d6, 6), pentagonal prism (7), octahedron (d8, 8), dodecahedron (d12, 12),
  icosahedron (d20, 20). The Platonic dice render as the REAL solid; the
  pentagonal prism is built from an exact polygon ring, all normalized to a
  constant bounding radius.
- **Today's agenda backdrop**: an ambient day-timeline pinned to the right
  edge, sitting BEHIND the canvas (z-index 0, so the cube + stars render over
  it). Shows ONLY today's events (`eventsToday`) — all-day items as a header,
  timed events placed on a vertical time axis with hour ticks — and a glowing
  warm line marks the current time, re-rendered each minute. (The shape-name
  label is hidden — `display:none`; no longer surfaced.)
- **Shape name label**: the current shape's name + face count is shown on
  the right edge of the stage (e.g. "icosahedron · d20 · 20 faces") so
  shapes can be referenced by name.
- **Organic morph between shapes**: the transition is a smooth ~0.52s
  reshape, not an instant swap. A fixed-topology icosphere (detail 4)
  radially projects onto each target solid's face-planes, so every vertex's
  radius can be tweened (easeInOutCubic) with a subtle sine wobble (~5%)
  that swells in then out mid-morph. The crisp glowing edge-lines fade out
  for the morph and fade back in once it settles. At REST the body swaps to
  the true solid (flat per-face normals → crisp facets); the icosphere is
  only shown during the transition.
- **Optimized**: 24 blob draw calls → 3; dropped the PMREM environment,
  all lights, per-blob geometry sculpting and the pressure shader
  (blob.js/geometry.js/noise.js/pressureMaterial.js deleted).

## Update indicator polish (2026-06-12)

- **Downloading = number only**: the progress ring is gone; the slot shows
  just the live "NN%" while an update downloads.
- **"Open installer" ready state** uses the Lucide package-open glyph
  (picked over folder-open / external-link / play) instead of a checkmark,
  which was confusable with the transient "up to date" check.

## Loud update-available signal (2026-06-12)

- **Update banner**: when a newer release is detected (silent boot check
  or main's periodic check, now every 2h instead of 6h) a persistent
  "update available!" banner appears in the left side panel, directly
  above the profile/version footer row and matching the panel width. Its
  background "breathes" (slow brightness pulse, reduced-motion aware) to
  draw the eye. Clicking it runs the platform's existing download/install
  action — that is the only way to clear it (no dismiss). Previously the
  only signal was the small icon by the version chip (bottom-left), which
  users missed.
- **Background checks now reach the UI**: main's `update-available` event
  was stderr-only; it's now forwarded over new IPC `fg:update-available`
  ([main.js](apps/os/main.js) → [preload.js](apps/os/preload.js) →
  `announceUpdateAvailable()` in [boot.js](apps/os/src/renderer/boot.js)),
  so week-long sessions learn about releases without anyone clicking.
- **Old-version broadcast**:
  [cohort-data/asks/2026-06-12-update-your-app.md](cohort-data/asks/2026-06-12-update-your-app.md)
  — every install ≥v0.2.10 polling cohort-data renders it on the asks
  wall, nudging users on old builds (which predate the banner) to update.

## Arrow-key view-tab navigation + white-blink fix (2026-06-11)

- **←/→ cycle the current page's view tabs** (program handbook pages,
  cohort views, calendar/presence, context views) with wrap-around.
  One document-level handler in [alchemy.js](apps/os/src/renderer/alchemy.js)
  clicks the neighbouring `.alch-page-views` / `.alch-prog-tabs` button, so
  each page's existing wiring does the work. Skips typing contexts and
  modifier'd arrows (alt+←/→ stays history nav).
- **Page-switch white blink fixed**: the body wash gradients set only a
  background-IMAGE, leaving `background-color` transparent — when a heavy
  page switch missed a raster deadline the compositor flashed the default
  white base. Solid fallback colors added under every body-wash gradient
  plus a `body::before` fixed backdrop on its own compositor layer
  (never invalidates, so dropped frames composite over the dark wash).
  Verified via CDP screencast: 3 white frames / 240 switches before,
  0 / 480 after.

## Calendar page redesign — one-view timeline (2026-06-11)

Replaced the day/week/presence sub-tabbed calendar with a single
Google-Calendar-shaped week view ([apps/os/src/renderer/calendar.js](apps/os/src/renderer/calendar.js) + `.css`):

- **Layout**: days as columns left→right (mon–sun), vertical hour axis,
  events as time-positioned blocks; overlapping events split side-by-side.
- **Never looks sparse**: the hour window hugs the week's actual content,
  runs of 2+ event-free hours collapse into thin hatched "open" bands
  (non-linear time axis), active hours stretch to fill the viewport, and
  unscheduled regions of each day are tiled with quiet "open" blocks.
- **Cards adapt to rendered size** (container queries): sliver = one line,
  tall = full title + detail bullets inline, no click needed; click opens
  a detail modal.
- **Robust time parsing** for the sheet's formats: `19:00 x`,
  `12:00-14:00 x`, `- 1600-1730 x`, `1600 - 1830: x`, `09:00am: x`;
  bare-time first lines promote the next line to the title.
- **Multi-day text events** (`Mon-Tue: …` in the first day's cell) mirror
  onto every covered day; day-name prefixes stripped from titles.
- **All-day lane** for untimed items, category-tinted chips.
- **Presence** (availability gantt) is a second tab on the page, using the
  shared `.alch-page-views` nav; gantt vertical scrolling fixed.
- **Navigation**: one centered strip `← 1 2 … 10 →`; today's week dot has
  a white outline, the viewed week fills oxide. Today is highlighted by
  white contrast only (no badge, no red).
- **Unified chrome**: shared view-nav tabs, standard canvas gutters across
  all pages (asks/cohort de-centered, cohort's narrowed padding removed),
  presence-head buttons share one pill style.
- Legacy renderer (`cohort-calendar-week.js` renderWeekView) remains in
  `packages/shape-ui` for the sibling web app; the Electron page no longer
  uses it. Saved `calendar2` modes/tabs migrate to `calendar`.
