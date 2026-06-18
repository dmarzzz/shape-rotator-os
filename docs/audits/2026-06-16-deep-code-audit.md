# Deep Code Audit — shape-rotator-os (2026-06-16)

> **Working-memory document.** Findings only — *no code changes have been made.* Each item is a proposal with rationale, effort (S/M/L/XL), and migration risk. Use this as the backlog/roadmap.
>
> **Scope of the ask:** the code *works as intended*. This audit is about **optimization & efficiency**, **maintainability**, and **extensibility** (plus tooling, architecture, and Electron security hardening). It is **not** a bug hunt.
>
> **Method:** multi-agent fan-out — one deep reader per subsystem, then an **adversarial verifier** re-checked every finding against the actual code. Nothing here was accepted on the auditor's word alone. Where the verifier **downgraded** a claim (8 findings marked *overstated*), the correction is folded in and flagged `⚠︎ corrected`. Ground-truth counts are in the appendix.

---

## TL;DR — honest assessment

This is a **mature, working, surprisingly thoughtful** codebase. The data-ingestion design (markdown → bundles → renderer, with a local-first overlay chain and graceful degradation), the Three.js core scene (`scene.js`), the calendar/transcript pipeline's domain-lib sharing, and the XSS-escaping discipline are all genuinely good and should be **preserved** (see [What NOT to change](#what-not-to-change-strengths)).

The debt is **concentrated and structural**, not scattered sloppiness. Four themes account for almost everything:

1. **Cross-consumer duplication.** The same logic is reimplemented per consumer and kept in sync by hand: the cohort *surface* parse/shape exists in **3–5 places**, `shape-ui` is maintained as **two hand-synced copies that have already drifted in 5 files both directions**, and CLI/IO plumbing in `scripts/` is copy-pasted across ~50 files.
2. **Hardcoded registration / no registry.** Adding a tab/page/app is a **4–6 file shotgun edit** with no manifest and no compiler to catch a missed site.
3. **Mega-files.** `alchemy.js` (15.6k lines), `boot.js` (9.4k), `build-bundles.js` (2.4k), `main.js` (2.2k) each fuse 6–10 unrelated concerns.
4. **No tooling floor.** Zero lint/format/type-checking anywhere; the 50-file test suite is a hand-maintained string that **runs in no CI workflow**; the shipped Electron app has **zero tests**.

Plus a cluster of **Electron security-hardening** gaps (no navigation guards, `sandbox:false` on every window, `unsafe-inline` CSP on the main window, unvalidated IPC, plaintext-TCP device-link, LAN-trust on by default) and **performance** wins (8 MB GLB, a real GPU-buffer leak, render loops that never pause when hidden, sync FS on the main thread).

---

## Highest-leverage roadmap (prioritized)

Ordered by *(impact ÷ effort) × how much it unblocks other work*. IDs link to detail below.

### P0 — cheap, high-impact, do first
| ID | What | Effort | Why now |
|----|------|--------|---------|
| [`unit-tests-not-in-ci`](#unit-tests-not-in-ci) + [`handmaintained-test-list`](#handmaintained-test-list) | Glob test runner (`node --test "scripts/**/*.test.{js,mjs}"`) **and** add a test job to `os-pr-checks.yml` | S | The 50 tests guarding the auto-merging calendar/transcript pipeline currently run in **no CI**. One-line fix raises the floor under every other refactor. |
| [`no-navigation-or-window-open-guard`](#no-navigation-or-window-open-guard) | `setWindowOpenHandler` + `will-navigate` guard on all 4 windows | S | Closes an entire Electron escalation class; the app renders on-disk/remote content. |
| [`os-vendor-shape-ui-unguarded-drift`](#os-vendor-shape-ui-unguarded-drift) | Extend the parity test to **all 13** shape-ui files; reconcile the 5 already-drifted files | S→M | The two copies have **already diverged both directions** — a naive resync corrupts one app. Freeze the drift before fixing the root cause. |
| [`rubiks-dispose-leaks-gpu-buffers`](#rubiks-dispose-leaks-gpu-buffers) | Traverse + dispose geometries/materials/env-texture in `rubiks.dispose()` | S | Real, repeatable VRAM leak each membrane entry/exit. ~5-line fix. |
| [`raf-loops-dont-pause-when-hidden`](#raf-loops-dont-pause-when-hidden) | `document.hidden` short-circuit in both render loops | S | Battery/GPU waste; the visibility pattern already exists in `boot.js`. |

### P1 — high-impact, medium cost
| ID | What | Effort | Why |
|----|------|--------|-----|
| [`no-lint-format-typecheck`](#no-lint-format-typecheck) | Staged ESLint → Prettier → `tsc --checkJs` (start on `main.js`/`preload.js`/data-layer) | L | No automated guardrail on ~31k lines in 3 files. `no-undef` alone catches the `window.*` coupling typos. |
| [`triplicated-surface-parse-and-shape`](#triplicated-surface-parse-and-shape) + [`no-shared-read-model`](#no-shared-read-model) | Extract `packages/cohort-model` (parse + shape + memoized read-model), consumed by build-bundles, OS renderer, **and** web | L | Kills the parity-test treadmill and a whole class of "which data source resolved?" bugs. Single biggest tax on extending the data model. |
| [`no-shared-cli-io-helper`](#no-shared-cli-io-helper) + [`google-auth-request-duplication`](#google-auth-request-duplication) | `scripts/lib/cli.cjs` + `scripts/lib/google-calendar.cjs` | L | `arg()` ×45, `usage()` ×51, `readJson` ×27, `resolveGoogleAccessToken` ×10 copy-pasted. `node:util.parseArgs` already adopted in 8 newer scripts — converge on it. |
| [`glb-decompressed-8mb-committed`](#glb-decompressed-8mb-committed) | Meshopt (worker-free) or decimate the mesh; strip dead UVs; consider release-asset fetch | M | 8 MB committed binary = 5.8× inflation of a 1.37 MB Draco source, plus 1.74 MB of UVs for a model with **zero textures**. |
| [`web-app-no-csp`](#web-app-no-csp) | Add CSP + security headers in `vercel.json` (report-only first) | S | Public site renders cohort markdown with **no CSP**; the OS app already proves a working policy for the same components. |

### P2 — high-impact, large cost (plan together)
| ID | What | Effort | Why |
|----|------|--------|-----|
| [`hardcoded-tab-app-registration`](#hardcoded-tab-app-registration) + [`renderer-monolith-modules`](#renderer-monolith-modules) | Page/app **registry** + split `alchemy.js`/`boot.js` into `renderer/pages/*` and `renderer/nav.js` | XL | These two reinforce each other: each page module's `{render, wire, title, icon}` *is* the registry entry shape. Do it page-by-page, verifying against the smoke test. |
| [`main-js-god-file-context-vault`](#main-js-god-file-context-vault) | Extract `context-vault.js`/`auto-updater.js`/`calendar-export.js` from `main.js` | L | ~950 of 2180 lines are an Electron-free-testable ingestion engine welded to `ipcMain`. |
| [`build-bundles-god-script`](#build-bundles-god-script) | Split into `scripts/lib/cohort/*` + add `require.main` guard + unit tests | XL | 2397 lines / 96 functions, unguarded `main()`, product-critical scoring with **only source-text "tests"**. |
| [`sprawling-unvalidated-ipc-surface`](#sprawling-unvalidated-ipc-surface) | One naming convention + `validate(shape)` wrapper + central registry | L | 101 IPC handlers, two conventions, almost no payload validation. |

### P3 — lower-leverage but worth scheduling
`renderer-unbundled-shipped` · `esm-cjs-split-undocumented` · `inconsistent-main-guard-and-error-handling` · `duplicated-fnv1a-and-escape-helpers` · `github-fetch-cache-reimplemented` · `vendored-three-addons-duplicated` · `easel-frame-per-call-ipc-copy` · `sync-fs-and-corpus-rebuild-in-ipc-handlers` · `device-link-plaintext-tcp-on-window-open` · `swf-node-binds-0000-with-lan-trust` · `web-cache-busting-torn-module-graph` · `dead-shape-ui-exports` · `feed-dead-code` · `dead-vendor-web-js` · `membrane-css-monolith` · `script-src-unsafe-inline-csp` · `manual-only-scripts-undocumented` · `web-runtime-config-not-rebuilt-on-vercel`

---

## What NOT to change (strengths to preserve)

Honest credit — these are done well; don't "refactor" them:

- **`membrane/scene.js`** — clean rAF loop with dt-clamping, `ResizeObserver`, frame-rate-independent physics, and a *complete* `destroy()` that disposes everything. This is the model `rubiks.js` should follow.
- **Lazy-loading of the Rubik's easter-egg** — dynamic `import()` only after the user cycles every die shape; costs nothing on boot.
- **`three` is a normal pinned npm dep** (via importmap), not a vendored fork — core-update story is just a `package.json` bump. (Only the *addons* are hand-vendored — see `vendored-three-addons-duplicated`.)
- **`scripts/lib/` domain sharing** — `calendar-integration.cjs`, `supabase-rest.cjs`, `env-file.cjs` (imported by 26 scripts). The *domain* layer is shared; only the *plumbing* layer isn't.
- **Google access via thin fetch-to-REST** (no heavyweight `googleapis` SDK) — a deliberate, defensible choice; keep it.
- **XSS hygiene** — consistent `escHtml`/`escAttr` from a shared `escape.js`; the component model is safe.
- **The local-first overlay chain in `cohort-source.js`** — LS snapshot → fixture → GitHub baseline → swf-node sync → Supabase evidence, with commit-ts tiebreaker and signature change-detection. Sophisticated and degrades gracefully.
- **`calendar-ingress` vendoring** — byte-identical copy with a clear comment **and** a real behavioral parity test (`calendar-ingress-parity.test.mjs`). This is the *good* vendoring pattern; copy it for shape-ui.
- **Dependency-injection style in scripts** (injectable `fetchImpl`/`argv`) — keep it through any refactor so the tests survive.

---

## Findings by subsystem

Legend: **Impact** is the verifier-corrected value where it differs. `⚠︎ corrected` = verifier downgraded/refined the original claim.

### 1. Electron main process & IPC boundary

<a id="no-navigation-or-window-open-guard"></a>
#### `no-navigation-or-window-open-guard` — No `setWindowOpenHandler`/`will-navigate` guard on any window · **security-hardening · HIGH · S · low risk**
- **Files:** `apps/os/main.js:1135` (createWindow), `:1187` (hermes), `:2103` (PDF), `apps/os/daybook-main.js:83` (router)
- **Now:** Repo-wide grep finds zero `setWindowOpenHandler`/`will-navigate`/`will-redirect`; the only `webContents` guard anywhere is the router's `setPermissionRequestHandler`. `window.open`/`target=_blank` spawns a new `BrowserWindow` whose `webPreferences` are **not** inherited; an in-page nav moves the renderer to a foreign origin unguarded.
- **Why:** On Electron's mandatory security checklist — the main path by which rendered content escalates into a weaker-isolation window.
- **Proposal:** Shared helper on every window: `setWindowOpenHandler` → `shell.openExternal` for `https?:` then `{action:'deny'}`; `will-navigate` → `preventDefault()` anything not the app's own `file://` page.
- *Verified.* ⚠︎ One sub-claim trimmed: Matrix bodies are **not** a live XSS sink today — `chat.js:429` escapes via `esc()`. The navigation gap itself stands at HIGH.

<a id="main-js-god-file-context-vault"></a>
#### `main-js-god-file-context-vault` — `main.js` is a 2180-line god-file; ~half is an unrelated ingestion engine · **maintainability · HIGH · L · medium risk**
- **Files:** `apps/os/main.js:155-1112` (vault engine), `:1247-1320` (its 5 IPC handlers)
- **Now:** ~950 lines (`walkTranscriptFiles`, `scanTranscriptFile`, `inferSpeakers/SkillAreas/Signals`, `parseSimpleFrontmatter`, `buildArticleEntries`, `writeContextVaultCorpus`, `normalizeContextVaultManifest`) back 5 `context-vault:*` handlers and share only `readJSON`/`writeJSON` with the rest. `autoUpdater`, swf-node wiring, swarm spawn, easel handlers also inlined.
- **Why:** Hard to navigate safely; the engine has no test seam because it's welded to `app.getPath`/`ipcMain`.
- **Proposal:** Extract `context-vault.js` (taking dirs as args → Electron-free testable), then `auto-updater.js`, `calendar-export.js`; register handlers from a thin registrar.
- *Verified exact (2179 lines; clean extraction boundary).*

<a id="sprawling-unvalidated-ipc-surface"></a>
#### `sprawling-unvalidated-ipc-surface` — 101 IPC handlers, two naming conventions, almost no payload validation · **architecture · MEDIUM · L · medium risk**
- **Files:** `main.js:1247-1448`, `daybook-main.js:111-674`, `preload.js:3-182`
- **Now:** `ipcMain.handle/on` × 101 (55 in main, 46 in daybook). Namespaced (`fg:*`,`matrix:*`,`easel:*`,`prefs:*`) vs ~40 un-namespaced daybook channels (`bootstrap`,`join`,`link-connect`,`link-ssh-connect`…). Validators are the exception (`shell:openExternal` https-check, `shell:openDownloadedInstaller` allowlist); most handlers use the payload raw — `prefs:save` persists any object, `clipboard:write` unbounded, `link-*` forward renderer targets into network+spawn.
- **Proposal:** One convention (namespace daybook behind `daybook:*` via adapter so the vendored renderer stays byte-identical), a `validate(shape)` wrapper, central enumerable registration.
- *Verified exact (counts confirmed).*

<a id="sync-fs-and-corpus-rebuild-in-ipc-handlers"></a>
#### `sync-fs-and-corpus-rebuild-in-ipc-handlers` — Sync FS + full corpus regen on the main thread inside IPC handlers · **performance · MEDIUM · M · medium risk**
- **Files:** `main.js:1249-1254`, `:953-1058`, `:1060-1099`, `:218-236`
- **Now:** `context-vault:manifest` deep-compares via `JSON.stringify` and, on drift, **synchronously rewrites** corpus markdown + raw bundle (up to 2 MB/source). `context-vault:scan` walks up to 350 files (`readdirSync`/`statSync`/`readFileSync` + regex passes) — all sync on the thread that also services matrix/easel/swf-node IPC. A read-only manifest fetch can re-trigger the corpus rewrite.
- **Proposal:** Run `buildContextVaultManifest` in a `worker_threads`/`utilityProcess`; at minimum convert to `fs.promises`. Gate the normalize-time rewrite behind a fingerprint check so reads never write.
- *Verified.*

<a id="swarm-fire-and-forget-no-cleanup-on-quit"></a>
#### `swarm-fire-and-forget-no-cleanup-on-quit` — research-swarm child not stopped on quit · **correctness-risk · MEDIUM · S · low risk**
- **Files:** `main.js:2166-2177`, `swarm-node.js:73-179`
- **Now:** `before-quit` awaits `swfNode.stop()` but never `swarm.stop()` (wired only to the `fg:swarm:stop` IPC). Child spawns `detached:false`; an in-flight run survives quit as an orphan still making billable LLM/network calls. `swarm-node.js:167-179` already has SIGTERM→2s→SIGKILL.
- **Proposal:** Call `swarm.stop()` in `before-quit`, mirroring the swf-node shutdown.
- *Verified.*

<a id="easel-frame-per-call-ipc-copy"></a>
#### `easel-frame-per-call-ipc-copy` — NDI ships full RGBA frames over `invoke`, cloning every frame across the bridge · **performance · MEDIUM · M · medium risk**
- **Files:** `preload.js:105-137`, `main.js:1646`, `easel-ndi.js:52-79`
- **Now:** `easel:frame` round-trips ~8 MB (1080p RGBA) per call via `ipcRenderer.invoke` (structured-clone + promise per call at 30 fps), then `easel-ndi.js:59` does another `Buffer.from(data)` copy. Busy/latest-wins flag bounds queue depth, not per-frame copy cost.
- **Proposal:** `ipcRenderer.postMessage` with a **transferable** `ArrayBuffer` (ownership moves, no clone). Same for rx/thumb if profiling shows it.
- *Verified.* (Only bites while NDI actively broadcasting.)

<a id="device-link-plaintext-tcp-on-window-open"></a>
#### `device-link-plaintext-tcp-on-window-open` — Device-link does plaintext-TCP pairing + SSH egress, partly on router-window open · **security-hardening · MEDIUM · M · medium risk**
- **Files:** `daybook-main.js:33-36`, `:420-444`, `daybook/link.js:1-23`
- **Now:** `link-*` IPC → vendored `link.js`: newline-delimited JSON over a **cleartext TCP socket**, authed by a base64url-of-JSON "secret" (no HMAC/TLS), plus SSH reads of remote `~/.claude`/`~/.codex`. `link.collectPeerToday` folds saved peers into **every** `buildDraft` → SSH egress on window open. On a shared LAN, payloads are observable/MITM-able.
- **Proposal:** Gate `collectPeerToday` behind an explicit per-session toggle (no implicit egress on `buildDraft`); wrap transport in TLS or an authenticated noise/libsodium channel. If upstream byte-identity blocks editing `link.js`, gate in the daybook handlers.
- *Verified end-to-end.* Riskiest, least-visible egress path in the main process.

<a id="swf-node-binds-0000-with-lan-trust"></a>
#### `swf-node-binds-0000-with-lan-trust` — swf-node sidecar binds `0.0.0.0` with `SWF_TRUST_LAN_PEERS=1` by default · **security-hardening · MEDIUM · M · medium risk**
- **Files:** `swf-node.js:313-340`
- **Now:** Hardcoded `SWF_BIND=0.0.0.0` + `SWF_TRUST_LAN_PEERS=1`; the inline comment says this *bypasses cohort-keys whitelist + single-writer-pin + fork detection* and that the spec labels it "Not for production cohorts." Justified by a closed-venue-WiFi assumption. Ships in release builds, non-configurable.
- **Proposal:** Make bind + trust-LAN a runtime setting defaulting to **loopback + trust-off**; opt into LAN mode from the network tab. At minimum gate the LAN-trust env behind a non-default opt-in.
- *Verified.*

<a id="script-src-unsafe-inline-csp"></a>
#### `script-src-unsafe-inline-csp` — Main-window CSP allows `'unsafe-inline'` in `script-src` · **security-hardening · MEDIUM · M · medium risk**
- **Files:** `src/index.html:5` (lax), `src/hermes/index.html:5` + `src/router/index.html:6` (already strict)
- **Now:** Main window: `script-src 'self' 'unsafe-inline'`. Hermes & router prove a strict `script-src 'self'` works in this same repo — and the main window renders the *most* untrusted content.
- **Proposal:** Drop `'unsafe-inline'` from `script-src` to match the siblings; nonce/externalize any inline bootstrap. Pairs with the navigation guard.
- *Verified.*

<a id="pdf-export-window-loadurl-data-html"></a>
#### `pdf-export-window-loadurl-data-html` — Calendar PDF export loads a renderer-supplied `data:` URL with `sandbox:false`, no validation · **security-hardening · LOW · M · low risk**
- **Files:** `main.js:2103-2121`
- **Now:** `fg:export-calendar` interpolates `opts.dataUrl` straight into `<img src="${opts.dataUrl}">` inside an HTML string loaded via `loadURL('data:text/html,...')`, in a window with **`sandbox:false`** and no check that `dataUrl` is `data:image/`.
- **Proposal:** Validate against `^data:image/(png|jpeg|webp);base64,`; set `{sandbox:true, nodeIntegration:false, contextIsolation:true}`; prefer `loadFile` + IPC handoff.
- *Verified.* ⚠︎ Note: `sandbox:false` is set explicitly (worse than omitted); `nodeIntegration` defaults false in E33 so its absence is benign.

<a id="duplicated-broadcast-and-console-helpers"></a>
#### `duplicated-broadcast-and-console-helpers` — Duplicated broadcast loop + console forwarder using **stale Electron-33 console arity** · **duplication · LOW · S · low risk**
- **Files:** `main.js:1378-1383`, `:1607-1611`, `matrix.js:123-128`, `main.js:1171-1173`, `daybook-main.js:105-107`
- **Now:** "send-to-all-windows" loop reimplemented 3× ; console forwarder copy-pasted 3× using the **old** `(_e, lvl, msg)` signature. `runSmokeTest:46-56` explicitly handles the E33 `(event, {level,message})` shape — the production handlers don't, so on Electron ^33 they **mislabel renderer log levels**.
- **Proposal:** `apps/os/ipc-util.js` with `broadcast(channel,payload)` + `attachConsoleForwarder(wc,tag)` (E33-aware), used everywhere.
- *Verified — production handlers are latently wrong on E33.*

**Verifier-added (main):**
- `no-sandbox-true-on-any-app-window` — **MEDIUM.** Every window sets `sandbox:false` (`main.js:1143`,`:1195`,`daybook-main.js:95`,`:2107`). Preload runs with full Node; a renderer RCE isn't contained by Chromium's sandbox. Likely intentional for the unbundled-ESM preload — surface it as a known tradeoff. → fold into the hardening epic.
- `prefs-and-window-state-no-atomicity-guard-on-quit-write` — **LOW.** `prefs:save` persists any renderer object verbatim, reloaded on boot. `writeJSON` is atomic (tmp+rename) but there's no shape/size guard. Same root as `sprawling-unvalidated-ipc-surface`.

---

### 2. Renderer mega-files (`alchemy.js`, `boot.js`, `atlas.js`)

> `atlas.js` (5997 lines) was found **healthy** — not flagged. The concern is `alchemy.js` + `boot.js`.

<a id="renderer-monolith-modules"></a>
#### `alchemy-split` / `boot-split` / `renderer-monolith-modules` — Renderer logic concentrated in two enormous modules that conflate routing, rendering, data, and wiring · **architecture/maintainability · HIGH · XL · medium risk**
- **Files:** `alchemy.js:792-855` (mode dispatch), `boot.js:485-1953` (engine) + `:2047-9437` (~40 panels), `boot.js:6131-6386` (router)
- **Now:** `alchemy.js` (750 KB, 569 fns) owns **all** OS pages (membrane, shapes, constellation, calendar, profile, onboarding, program, asks, context) via one if/else `renderModeContent` + a *separate* post-render wiring if/else ~15 lines away. `boot.js` (408 KB, 274 fns) fuses the Three.js boot animation, the top-tab router, network/metrics/livegraph panels (~40 `innerHTML` renderers), mouse-history nav, keyboard shortcuts, swarm panel, and the `__srwk*` global hooks. The small pure modules (`lenses`,`shapes`,`damping`,`cohort-relations`) are the only clean seams.
- **Why:** Touching one page risks a 15k-line module; cross-page coupling + merge conflicts near-certain on a multi-contributor project.
- **Proposal:** Split `alchemy.js` → `renderer/pages/*` each exporting `{render, wire, title, icon}` (= the registry entry shape — see `hardcoded-tab-app-registration`). Pull the router + `__srwk` hooks out of `boot.js` into `renderer/nav.js`. Migrate **page-by-page**, each independently shippable + smoke-tested.
- *Verified — all 9 page renderers + 24 `wire*` fns + the fused router confirmed.*

<a id="feed-dead-code"></a>
#### `feed-dead-code` — Kill-switched feed still ships · **dead-code · MEDIUM · M · low risk** ⚠︎ corrected
- **Files:** `alchemy.js:124` (`FEED_DISABLED=true`), `:13776-14299`
- **Now:** ~**520** lines (not 600) of feed UI + GitHub scraper are unreachable (`refreshFeed` short-circuits at `:13785`).
- ⚠︎ **Correction:** `buildWhatsNewFeed` (`:1201`) is **LIVE** — a fallback inside `computeMembraneData` (`:1538`) feeding the default landing surface. **Do not archive it.** `state.events` plumbing is also still partly live (`loadEventsCache` at mount). Only the renderers + scraper are dead.
- **Proposal:** Move just the dead feed renderers + scraper to `_archive/`; leave `buildWhatsNewFeed` and the events cache alone.

<a id="full-rebuild"></a>
#### `full-rebuild` — `render()` rebuilds the whole canvas + re-wires per navigation · **performance · MEDIUM · L · medium risk** ⚠︎ corrected
- **Files:** `alchemy.js:743-861`, `:6776-7657`
- **Now:** `render()` does `destroyAllShapes()` (WebGL2 teardown) + full `innerHTML` rewrite (26 sites) + re-attach all listeners.
- ⚠︎ **Correction:** the proposed "update in place" **already exists** for node selection — `selectOrOpen` (`:6874`) calls `setConstellationInspector` (in-place DOM patch, no teardown) when a live `.ac-inspector` exists; `render()` is only the fallback for journey/stack views. Bound guards prevent listener leaks. **Remaining valid gap:** lens/scope/interest **filter-chip** changes trigger a full `render()` even when the shape set is unchanged.
- **Proposal:** Skip `destroyAllShapes()` when the shape set is unchanged on filter/lens/scope changes; extend the existing in-place path to cover them.

**Verifier-added (renderer-mega):**
- `cohort-index-unmemoized` — **MEDIUM.** `buildCohortIndex` (`cohort-relations.js:13`) rebuilds 5+ Maps on every call, unmemoized, called 16× across `alchemy.js`; several fns take it as a *default param* that rebuilds the whole index when omitted. Memoize on cohort identity (`WeakMap`) keyed off the existing `surface._sig`. → merges with `no-shared-read-model`.
- `shape-ui-double-copy` — see `os-vendor-shape-ui-unguarded-drift` below (cross-listed).

---

### 3. Renderer support modules

<a id="duplicated-fnv1a-and-escape-helpers"></a>
#### `duplicated-fnv1a-and-escape-helpers` — FNV-1a hash + HTML-escape copy-pasted across the renderer, with **divergent** escape variants · **duplication · MEDIUM · M · low risk**
- **Files:** `cohort-source.js:707`, `whats-new.js:42`, `ux.js:144`, `identity.js:661`, `easel.js:122`, `intel/intel.js:44`, `calendar-ingress.mjs:58` (+ boot/atlas/alchemy/chat/membrane)
- **Now:** FNV-1a (seed `2166136261`) reimplemented **11×**. HTML-escape defined independently in ~7 places; **they disagree** — `ux/intel/calendar-ingress` escape the single quote, `easel.js:122` and `identity.js` (escHtml, with `escAttr` aliased to it) do **not**. `boot.js` has *two* variants (one escapes no quotes at all).
- ⚠︎ **Correction:** a canonical `escHtml`/`escAttr` **already exists** in `packages/shape-ui/src/escape.js`, and `alchemy.js` already imports it. So the fix is "**import the existing helper**" in the ~6 support modules + boot, not "create a new util." Caveat: shape-ui's `escAttr` itself doesn't escape `'`, so harden it (and add a test) if a quote-safe attribute escaper is the goal.
- **Proposal:** Make `escAttr` quote-safe in shape-ui; import it everywhere; add a shared `fnv1a`/`stableStringify` and replace the 11 hand-rolled hashes (one already caused a v1→v2 LS-key bump from a Date-vs-string mismatch).

<a id="github-fetch-cache-reimplemented"></a>
#### `github-fetch-cache-reimplemented` — GitHub fetch + localStorage-TTL cache reimplemented twice · **duplication · MEDIUM · M · low risk**
- **Files:** `cohort-source.js:472-549`, `gh-user.js:17-107`
- **Now:** Near line-for-line clones (24h positive / 1h negative TTL, fail-open, 250 ms jitter against the 60 req/hr unauth budget). Source comments literally say "Mirrors gh-user.js."
- **Proposal:** Extract `ghCache.js` exposing `cachedJsonFetch(url, {cacheKey, ttlMs, negTtlMs, jitterMs})`; both call sites consume it.
- *Verified* (⚠︎ minor: the cache-buster param is *not* part of the shared pattern).

<a id="no-tests-for-data-layer"></a>
#### `no-tests-for-data-layer` — The renderer's trickiest pure logic has no tests · **maintainability · MEDIUM · L · low risk** ⚠︎ corrected (was HIGH)
- ⚠︎ **Correction:** the blanket claim is wrong for 2 of 4 modules — `supabase-evidence.mjs` **is** tested (`supabase-evidence.test.mjs`) and `cohort-relations.js` `buildCollabModel` **is** tested (`test-model-helpers.mjs`). 
- **Real remaining gap (narrower but real):** `cohort-source.js` `mergeSyncOverBaseline` (the GH-commit-ts vs sync-wall-ts tiebreaker + fail-open, `:627-682`), `whats-new.js` `unreadCounts/markModeSeen` prime-then-diff (`:114-185`), and `sync-client.js` have **zero** tests — and these are pure-ish functions that fail *silently* (stale/dup data, not a crash).
- **Proposal:** Add `node:test` files for those three; wire into the (glob) test list.

**Verifier-added (support):** `shape-ui-escape-module-not-reused-by-support-modules` — same point as the escape correction above.

---

### 4. Membrane / Three.js / Rubik's cube

> Core verdict: **more carefully built than its size suggests.** `scene.js` is high-quality. Concerns cluster in the GLB asset, one missing dispose, and visibility-pausing. (`matrix.js` was mis-grouped here — it's a main-process chat client, nothing to report.)

<a id="glb-decompressed-8mb-committed"></a>
#### `glb-decompressed-8mb-committed` — 8 MB GLB is a decompressed copy of a 1.37 MB Draco source; geometry also over-tessellated · **optimization · HIGH · M · medium risk**
- **Files:** `membrane/rubiks_cube.glb`, `rubiks.js:30-33`, `rubiks-cube-web/rubiks_cube.glb` (untracked 1.37 MB Draco source), `rubiks-cube-web/decompress-glb.cjs`
- **Now:** 8,003,580 bytes committed (every revision stores 8 MB). 85k triangles / 228k verts for a 3×3 cube, **zero textures**, yet carries **1.74 MB of dead TEXCOORD_0 UVs**. `decompress-glb.cjs` inflates the Draco source 5.86× to dodge the blob-URL worker the CSP forbids.
- **Proposal (worker-free options):** (a) **EXT_meshopt_compression** — decodes main-thread via `MeshoptDecoder` (tiny inline WASM, no Worker, CSP-OK); the vendored `GLTFLoader` already exposes `setMeshoptDecoder`. (b) **Decimate/re-bake** in Blender to a few-thousand-triangle cube. Complementary: **strip the UVs** in the decompress build (~1.7 MB free), and/or fetch the binary as a release/CDN asset at first reveal (the white-flash already masks load).
- *Verified by parsing the GLB header directly (counts exact).*

<a id="rubiks-dispose-leaks-gpu-buffers"></a>
#### `rubiks-dispose-leaks-gpu-buffers` — `rubiks.js dispose()` leaks all cloned geometries/materials + the PMREM env texture · **performance · HIGH · S · low risk**
- **Files:** `rubiks.js:904-916` (dispose), `:197`/`:317` (clones), `:60` (env), `alchemy.js:775-779` (teardown)
- **Now:** `buildCube` clones geometry per mesh; `splitMeshByTriangle` clones again; several materials cloned; `scene.environment` is a PMREM render-target. `dispose()` calls `renderer.dispose()` but **never traverses the scene** to dispose those clones or the env texture — `renderer.dispose()` does **not** free them. Leaks ~85k-tri worth of VRAM **once per membrane entry/exit cycle**, unbounded over a session.
- ⚠︎ **Correction:** it does **not** leak per reveal/hide *within* one mount (`ensureRubiks` memoizes; reveal/hide just toggles `setEnabled`). Still a genuine per-entry leak. (`forceContextLoss` is not used anywhere in the membrane — `scene.js` is thorough only because its sub-objects self-dispose.)
- **Proposal:** Before `renderer.dispose()`, `scene.traverse` → dispose every mesh geometry + material(s); dispose `scene.environment`, `darkMat`, and the shader passes; optionally `forceContextLoss()`.
- *Verified.*

<a id="raf-loops-dont-pause-when-hidden"></a>
#### `raf-loops-dont-pause-when-hidden` — Both render loops keep running when the window is hidden/minimized · **performance · MEDIUM · S · low risk**
- **Files:** `scene.js:289-351`, `rubiks.js:840-859`, precedent at `boot.js:3491`/`7832`
- **Now:** `scene.tick()` (bloom composer + starfield) gated only on `running`; `rubiks.frame()` (two full `scene.traverse()` material-swap passes + two composer renders) gated only on `enabled`. Neither checks `document.hidden`. `boot.js` already pauses a metrics poll on `visibilitychange`.
- **Proposal:** `document.hidden` short-circuit at the top of both loops + one `visibilitychange` resume listener per scene (removed in dispose). Reuse the boot.js convention.
- *Verified* (dt is clamped, and Chromium throttles hidden tabs, so practical burn is bounded — but minimized Electron windows aren't always throttled).

<a id="vendored-three-addons-duplicated"></a>
#### `vendored-three-addons-duplicated` — Vendored three addons duplicated between `three-jsm/` and `three-extras/`; no re-vendor step · **duplication · MEDIUM · M · low risk**
- **Files:** `vendor/three-extras/postprocessing/UnrealBloomPass.js` (+ Pass, CopyShader, LuminosityHighPassShader) vs the byte-identical `three-jsm/` copies; `boot.js:11` imports from `three-extras`, membrane from `three-jsm`
- **Now:** Four files byte-identical across the two trees (verified with `diff -q`). No script re-vendors them from `node_modules/three/examples`, so they'll silently drift from the npm core (JSM addons are version-locked to core) on the next `three` bump.
- **Proposal:** Collapse `three-extras` into `three-jsm`; add `scripts/vendor-three-addons.cjs` run on `three` bumps; document the pinned revision. (`bundle:check` already gates that the import graph resolves.)
- *Verified* (⚠︎ `three` is a caret range `^0.184.0`, pinned only via lockfile).

<a id="membrane-css-monolith"></a>
#### `membrane-css-monolith` — `membrane.css` is one 2470-line / 80 KB sheet covering 6 subsystems · **maintainability · LOW · M · low risk**
- **Now:** One flat cascade styling canvases, Rubik's controls, feed, agenda, and the **retired** (permanently hidden, `index.js:1085`) panel/seal/crewid card → likely dead-shipped CSS at `:2158-2417`.
- **Proposal:** Split along seams (`membrane.scene/feed-agenda/panel/rubiks.css`); audit the retired block for dead rules. Lower priority than GLB/dispose/visibility.

<a id="solver-solve-blocks-main-thread"></a>
#### `solver-solve-blocks-main-thread` — Kociemba `solve()` is synchronous on the click handler · **performance · LOW · M · medium risk**
- **Now:** `cube-solver.js` is cubejs@1.3.2 verbatim; `solve()` is a sync IDA* search. **Already well-mitigated** — the expensive pruning-table build is deferred to `requestIdleCallback` (`rubiks.js:876`), so warmed solves are tens of ms.
- **Proposal:** Accept as-is (option a). A worker would need a real worker file + a CSP `worker-src 'self'` (blob workers are forbidden). Flagged for honesty, not alarm.

**Verifier-added (membrane):**
- `glb-texcoord-deadweight` — **LOW.** 1.74 MB of UVs in a texture-less model; strip in the decompress build. (Folded into the GLB proposal.)
- `selective-bloom-per-frame-traverse-cost` — **LOW.** `render()` does two full `scene.traverse()` material-swap passes + a uuid-keyed Map churn **every frame**. Cache the glow/non-glow partitions once at setup; store saved material on the mesh, not a Map.

---

### 5. `scripts/` Node pipeline

> Verdict: **better than its size suggests** — domain logic is genuinely shared via `scripts/lib/`, every non-trivial script has co-located tests, and most accept injectable `fetchImpl`/`argv`. The debt is *plumbing*, not domain.

<a id="no-shared-cli-io-helper"></a>
#### `no-shared-cli-io-helper` — CLI/IO plumbing copy-pasted across ~50 scripts despite an existing `lib/` · **duplication · HIGH · L · medium risk**
- **Now:** `lib/` has 8 **domain** modules but no CLI/IO helper. Verified byte-identical copies: `arg()` ×**45**, `flag()` ×**19**, `readJson`/`writeJson` ×**27**, `usage()` ×**51**. Even 40-line wrappers re-declare them.
- **Proposal:** `scripts/lib/cli.cjs` (`parseArgs`/`arg`/`flag`/`required`/`usage`) + `scripts/lib/io.cjs` (`readJson`/`writeJson` with the `-` stdin convention). Migrate incrementally; keep the `argv`-param DI style the tests rely on. Consider `node:util.parseArgs` under the hood.
- *Verified (counts exact).*

<a id="google-auth-request-duplication"></a>
#### `google-auth-request-duplication` — Google token resolution + Bearer fetch duplicated across 10+ scripts · **duplication · HIGH · L · medium risk**
- **Now:** A shared low-level `refreshAccessToken` exists, but the wrapper isn't shared: `resolveGoogleAccessToken` ×**10**, `googleRequest` ×**6**, and **17** scripts hand-build `googleapis.com/calendar|drive` URLs + their own `nextPageToken` pagination. Auth precedence, retry-on-401, and pagination are correctness/security-sensitive and maintained in parallel.
- **Proposal:** `scripts/lib/google-calendar.cjs` exposing `resolveGoogleAccessToken` (wrapping `refreshAccessToken`), `googleRequest` (Bearer + JSON + error-normalize + `fetchImpl`), `paginate(listFn)`, and URL builders. Migrate mirror/backfill/sync first.
- *Verified (counts exact).*

<a id="handmaintained-test-list"></a>
#### `handmaintained-test-list` — root `test` is a 2037-char hand-listed string of 50 files · **tooling · HIGH · S · low risk**
- **Now:** Currently 50/50 correct **by discipline only**. The convention is already imperfect — `test-model-helpers.mjs` doesn't match `*.test.*` and is wired via a separate script, so it's excluded from `npm test`. No `engines`/`type` field; Node 22 supports glob discovery.
- **Proposal:** `node --test "scripts/**/*.test.{js,mjs}"`; add `engines:{node:'>=22'}`; rename/justify `test-model-helpers.mjs`. Keep granular `test:*` scripts.
- *Verified.*

<a id="build-bundles-god-script"></a>
#### `build-bundles-god-script` — `build-bundles.js` is 2397 lines / 96 fns, unguarded `main()`, no direct test · **maintainability · HIGH · XL · medium risk**
- **Now:** Mixes markdown parsing, keyword scoring, evidence-card synthesis, project-week drift, and timeline rendering; inlines a `vm`-sandbox require; `main()` called unguarded at `:2397`. **No test imports it** — the two "tests" assert against its **source as a string** (regex on the file text), which breaks on rename and passes through behavioral regressions. This file compiles the product-critical cohort/intel bundles.
- **Proposal:** Thin entry + `scripts/lib/cohort/*` modules; add `require.main === module` guard; backfill **behavioral** unit tests for `driftForProjectWeek`/`claimSignalScore`/`buildProjectWeekSnapshots`.
- *Verified — if anything understated.*

<a id="dead-vendor-web-js"></a>
#### `dead-vendor-web-js` — `scripts/vendor-web.js` is dead (superseded by `.mjs`) · **dead-code · MEDIUM · S · low risk**
- **Now:** `vendor:web` runs the `.mjs`; the test asserts it; only a historical docs mention references the `.js`. Last touched in a release-fix commit.
- **Proposal:** Delete `vendor-web.js` after a final CI grep.
- *Verified — genuinely dead.*

<a id="esm-cjs-split-undocumented"></a>
#### `esm-cjs-split-undocumented` — Undocumented `.js`/`.mjs`/`.cjs` split forces `createRequire` in 9 scripts · **architecture · MEDIUM · M · low risk**
- **Now:** 65 `.js` (CJS) + 53 `.mjs` (ESM) + 1 `.cjs`, no `type` field, no README. Libs are `.cjs`-only, so 9 ESM scripts bridge via `createRequire`.
- **Proposal:** Document the convention in `scripts/README.md` (new = ESM); either add `.mjs` re-export shims for the libs, or longer-term `type:module` + batch conversion.
- *Verified.*

<a id="inconsistent-main-guard-and-error-handling"></a>
#### `inconsistent-main-guard-and-error-handling` — Many scripts run `main()` unguarded; uneven top-level error handling · **maintainability · MEDIUM · M · low risk** ⚠︎ corrected (numbers)
- ⚠︎ **Correction:** actual is **22/69 unguarded** (not 19/68) — slightly *worse* than stated. 33 scripts attach a `.catch`/`unhandledRejection`. Unguarded `main()` blocks unit-testing the pure logic (why `build-bundles` has no direct test).
- **Proposal:** A `runMain(fn)` helper in `scripts/lib/cli.cjs` wrapping guard + catch + `exit(1)` with a clean message; add the guard to the unguarded scripts.

<a id="manual-only-scripts-undocumented"></a>
#### `manual-only-scripts-undocumented` — A few scripts invoked by nothing (npm/CI/imports/docs) · **maintainability · LOW · S · low risk**
- **Now:** `build-cohort-timeline.js`, `create-google-calendar-event.js`, `prepare-google-calendar-event.js` have **zero** repo-wide references. (Others initially suspected are live — confirmed.)
- **Proposal:** Add a thin npm alias or a `scripts/README.md` "manual operations" entry for each; delete if confirmed superseded.
- *Verified precisely.*

**Verifier-added (scripts):**
- `parseargs-partially-adopted-context` — `node:util.parseArgs` is already used in 8 newer scripts → standardize `cli.cjs` on it (proven baseline, and it converges an already-diverging codebase).
- `build-bundles-source-text-tests-brittle` — **MEDIUM.** The two "indirect" tests regex the source string; replace with real imports once the `require.main` guard lands.

---

### 6. Shared UI (`shape-ui`), web app & vendoring

> There are **three** materialized copies of `shape-ui`: canonical `packages/shape-ui`, a committed hand-synced copy at `apps/os/src/vendor/shape-ui`, and a **gitignored, build-generated** `apps/web/shape-ui` (via `vendor-web.mjs`). The web copy is automated and safe — **the OS copy is the liability.**

<a id="os-vendor-shape-ui-unguarded-drift"></a>
#### `os-vendor-shape-ui-unguarded-drift` — OS vendor copy hand-synced with a 2-of-13-file parity test; **5 files have already drifted both directions** · **duplication · HIGH · M · medium risk**
- **Files:** `apps/os/src/vendor/shape-ui/*` vs `packages/shape-ui/src/*`; guard at `test-model-helpers.mjs:23`
- **Now:** The OS loads the vendor copy (importmap `index.html:33`). Of 13 files, 8 identical; **5 drifted** (verifier found one more than the auditor): `shape-canvas.js` gained a whole **drag-to-spin** feature *only in the vendor copy* (758 vs 592 lines); `cohort-calendar-week.js` gained an **add-to-calendar/.ics** feature *only in the package* (+287 lines); `cohort-calendar-week.css` (~2 KB diff); `tokens.css` (`--sidebar-w` 340 vs 320, plus a path difference); `index.js` (1 export line). Both `shape-canvas` copies were last edited **in the same commit** — proof the author edited one side and forgot the other. The parity test guards only `cohort-card.{js,css}`.
- **Why:** Worst of both worlds — maintainers *think* a test protects them. A naive `cp` resync corrupts one app no matter the direction.
- **Proposal:** **(S, do now)** extend the parity test to all 13 files (loop the dir, assert byte-equality) → freezes drift + forces reconciliation. **(M, real fix)** reconcile the 5 files, then delete the committed copy and **generate** it — `vendor-web.mjs` already has `syncShapeUi()`/`assertInside`/`cpSync`; add an OS target (`packages/shape-ui/src` → `apps/os/src/vendor/shape-ui`), gitignore it, run in prebuild/`beforePack`.
- *Verified by direct diff.*

<a id="dead-shape-ui-exports"></a>
#### `dead-shape-ui-exports` — Several shape-ui exports have zero consumers · **dead-code · MEDIUM · M · low risk**
- **Now:** `renderTeamCard`/`renderPersonCard`/`renderCohortCard` (HTMLElement renderers) — 0 consumers (both apps use the string `*Html` variants). `buildEventCalendarActions` — 0 anywhere. `prepareProfilePR`/`buildNewPRUrl`/`buildRecordPath` — 0. `renderProfileForm` — web-only (OS forks its own). ~1300 lines of `renderWeekView` — web-only (OS uses a forked `calendar2`), yet the OS still bundles it. (Keep `buildEditPRUrl` — it *is* consumed.)
- **Why:** A maintainer "improves" `renderCohortCard`/`buildEventCalendarActions` and ships code nobody runs — exactly how `buildEventCalendarActions` ended up in only one synced copy. The string-vs-HTMLElement dual API is a standing trap.
- **Proposal:** Decide the public surface and prune. Add a lint test: every name re-exported from `index.js` must be imported by ≥1 file under `apps/*`. The OS `vendor:os` sync can simply skip modules the OS never imports.
- *Verified by grepping every export against both consumer trees.*

<a id="web-app-no-csp"></a>
#### `web-app-no-csp` — Web app ships **no** CSP while the OS app has a strict one · **security-hardening · MEDIUM · S · low risk**
- **Files:** `apps/web/vercel.json:8`, all `apps/web/**/*.html`
- **Now:** `vercel.json` sets only `Cache-Control`. Zero CSP/`X-Content-Type-Options`/`Referrer-Policy`/`frame-ancestors` across all pages. The site renders cohort markdown-derived content via 1.5k-line hand-written HTML-string templates and holds a Supabase anon-key path.
- **Proposal:** Add CSP (start from the OS policy, swap `connect-src` to the web origins) + `nosniff` + `Referrer-Policy` + `frame-ancestors 'self'` in `vercel.json` headers. Roll out **report-only** first. Low risk — the same components already run under the OS CSP.
- *Verified.*

<a id="web-cache-busting-torn-module-graph"></a>
#### `web-cache-busting-torn-module-graph` — 60 s cache on un-hashed ESM can serve a torn module graph during deploys · **correctness-risk · MEDIUM · M · low risk**
- **Files:** `vercel.json:8`, `calendar/index.html:62`, `cohort/index.html:19`
- **Now:** `Cache-Control: max-age=60` on `/(.*)` covers every JS/CSS incl. the deep import graph (`cohort.js → @shape-rotator/shape-ui → cohort-card.js, escape.js…`), all by **un-hashed** paths. Only one file has a manual `?v=`. In the ~60 s post-deploy window a browser can hold a cached entry module while fetching a fresh imported module whose export set changed → unresolved-import white-screen. The single hand `?v=` shows the team already hit this.
- **Proposal:** Content-address the import graph (hashed filenames or per-build `?v=<gitsha>` in `vendor-web.mjs` + importmap); short-cache HTML, immutable-long-cache hashed assets. Drop the ad-hoc `?v=` once systematic.
- *Verified* (probability bounded by the 60 s `must-revalidate` window).

<a id="web-runtime-config-not-rebuilt-on-vercel"></a>
#### `web-runtime-config-not-rebuilt-on-vercel` — `deploy:web` regenerates `calendar-runtime-config.js`, the Vercel Git build doesn't · **tooling · LOW · S · low risk**
- **Now:** Local `deploy:web` runs `write-web-runtime-config.mjs`; Vercel's `buildCommand` runs only `vendor:web`. So a git-push deploy serves the committed config, ignoring the `SHAPE_CALENDAR_*`/`GOOGLE_GUEST_CALENDAR_ID` env overrides — "the link is wrong on prod but right when I deploy locally."
- **Proposal:** Chain `write-web-runtime-config.mjs` into the Vercel `buildCommand`; update `vendor-web.test.mjs` to assert it. Either way, converge the two deploy paths.
- *Verified* (degrades to the committed value, so benign-ish).

<a id="vendor-calendar-ingress-no-byte-parity-test"></a>
#### `vendor-calendar-ingress-no-byte-parity-test` — OS vendored `calendar-ingress-client.mjs` is byte-identical to web today, but nothing enforces it · **maintainability · LOW · S · low risk**
- **Now:** Currently `diff = 0`. The existing parity test catches *behavioral* divergence on exercised exports, but no test asserts **byte**-equality, so comments/whitespace/un-tested helpers can drift.
- **Proposal:** Add a one-line byte-equality assertion (mirror `test-model-helpers.mjs`), or better, generate the vendor copy via `vendor-web.mjs` and gitignore it. Lock it down while still identical.
- *Verified.*

**Verifier-added (shared-ui):**
- `web-cohort-surface-vendored-todo` — **LOW.** `apps/web/cohort/index.html:17` has a live TODO to wire `cohort-surface.json` into the deploy step; the web shape-ui importmap is the *correct* single-source pattern the OS fix should mirror.
- `vendor-cohort-calendar-week-css-also-drifted` — the 5th drifted file (see the drift finding above); the parity-test fix must cover CSS too.

---

### 7. Build, packaging, tooling & CI

<a id="no-lint-format-typecheck"></a>
#### `no-lint-format-typecheck` — Zero lint/format/type-checking across the codebase · **tooling · HIGH · L · low risk**
- **Now:** No `.eslintrc`/`eslint.config`/`.prettierrc`/`tsconfig`/`.editorconfig` **anywhere** (verified). ~31k lines in just `alchemy.js`+`boot.js`+`atlas.js` with no automated guardrail. Only static checks are esbuild import-resolution + a couple of bespoke `check-*.cjs`.
- **Proposal (staged):** (1) ESLint `recommended` + `import` plugin, non-blocking → required; `no-undef` catches the `window.__srwk*` coupling typos (allow the known globals). (2) Prettier + format-check. (3) `tsconfig` `checkJs`+`noEmit`, starting `// @ts-check` on `main.js`/`preload.js`/data-layer + a JSDoc typedef for the surface shape (catches cross-consumer drift **for free**). Wire into `os-pr-checks.yml`.
- *Verified.*

<a id="unit-tests-not-in-ci"></a>
#### `unit-tests-not-in-ci` — The 50-file unit suite runs in **no** CI workflow · **tooling · HIGH · S · low risk**
- **Now:** No workflow runs `npm test`/`node --test`. `os-pr-checks.yml` runs only cohort/parity/intel/bundle checks; `calendar-sync.yml` **auto-merges with no test step**. The tests cover logic that auto-commits to `main` and feeds the bundled surface.
- **Proposal:** Add a test job to `os-pr-checks.yml` running the (glob) suite.
- *Verified.* See also the verifier-added `no-tests-for-electron-app-code` (**MEDIUM**): `apps/os` has **zero** test files — the entire main process + renderer are untested; the only runtime guard is the mac-only afterPack boot smoke. Start a minimal unit layer on the pure helpers (`colors.js`, `damping.js`, `dimensions.js`, `cube-solver.js`) + a headless Electron smoke asserting no uncaught renderer errors.

<a id="renderer-unbundled-shipped"></a>
#### `renderer-unbundled-shipped` — Renderer ships as raw 15k-line files; the esbuild bundle is CI-only, never shipped · **performance · MEDIUM · L · medium risk**
- **Now:** `index.html` loads `boot.js` as a module + an importmap to `node_modules` inside the asar; `boot.js` then fetches every other module as a separate asar resolution+parse. `bundle-renderer.cjs` *can* emit one bundle but its header says the cutover is **deferred** (needs WebGL-tabs QA); `dist-renderer` is referenced only inside that script.
- **Why:** Many small fetches/parses on first paint; the importmap-to-asar coupling caused two prior regressions (why `after-pack-verify.cjs` exists).
- **Proposal:** Finish the deferred cutover behind a flag after the WebGL QA pass; ship the bundle, point `index.html` at it, run `bundle:check` as the build step.
- *Verified.*

**Verifier-added (build/CI):**
- `bundle-built-but-not-validated-against-runtime` — **LOW.** `bundle-renderer.cjs` hardcodes aliases to "mirror the importmap exactly" by hand; `@cosmos.gl/graph` is already in the importmap but **not** the alias list. Derive the esbuild aliases by parsing the importmap out of `index.html` (single source), or assert the key sets match.

---

### 8. Cross-cutting architecture & extensibility

<a id="triplicated-surface-parse-and-shape"></a>
#### `triplicated-surface-parse-and-shape` — The cohort `surface` parse + shape are reimplemented 3× (5× counting LS) and synced by hand · **duplication · HIGH · L · medium risk**
- **Files:** `build-bundles.js:54-120`, `cohort-source.js:155-447`, `apps/web/scripts/cohort.js:501`, parity guard `check-cohort-detail-parity.mjs`
- **Now:** `parseMarkdown`/`pickSurface`/`extractPublicPersonBio` are near-identical between the Node build and the browser runtime (the latter's header literally says "Mirrors what `build-bundles.js` does"). `RECORD_DIRS` mapping duplicated. `emptyShape()`/`normalize()` must be hand-matched to what `build-bundles` emits. The web app is a third consumer with its own `byId` maps. `check-cohort-detail-parity.mjs` exists **solely** to assert two hand-copies agree.
- **Why:** A new surface field must be added in schema.yml + build-bundles + cohort-source `normalize()`/`emptyShape()` + web — or the live GitHub path silently diverges from the fixture (a "which source resolved?" bug, the hardest kind to repro). Single biggest tax on extending the data model.
- **Proposal:** Extract a framework-free `packages/cohort-model` exporting `parseMarkdown`, `pickSurface`, `extractPublicPersonBio`, `RECORD_DIRS`, `emptyShape`, `normalize`. All three consumers import it; `schema.yml` stays the whitelist source. Deletes ~150 dup lines and makes the parity tests redundant. Keep it dependency-free so it loads unbundled.
- *Verified.* (⚠︎ minor: `calendar-ingress-parity.test.mjs` belongs to the vendoring finding, not this one.)

<a id="no-shared-read-model"></a>
#### `no-shared-read-model` — Record-by-id maps + relationship derivation rebuilt ad-hoc dozens of times · **architecture · HIGH · L · medium risk**
- **Files:** `alchemy.js` (15× inline `new Map(...record_id...)`), `cohort-relations.js:45`, `apps/web/scripts/cohort.js:512`
- **Now:** `alchemy.js` builds `teamById`/`peopleById`/`peopleByTeam` inline **15×**, each re-deriving from the same arrays. The reusable `buildCohortIndex` (seek/offer matching, clusters, name resolution) **exists** and is imported by `alchemy.js`+`find.js` — but it's **not memoized** (called ~17× per render path) and the **web app can't reach it** (it's under `apps/os/src/renderer/`) so it reimplements its own. OS and web can render the same data differently.
- **Why:** Naming/sorting/relationship rules (the substance of `docs/INFORMATION_RULES`) live per-call-site, not once.
- **Proposal:** Promote `cohort-relations.js` into the shared `packages/cohort-model` (or a sibling). Expose `buildModel(surface)` → memoized `{teamById, peopleById, peopleByTeam, clustersByTeam, edges, displayName(id), sortRecords()}`. All consumers use it. Within alchemy, build once per refresh keyed on the existing `surface._sig`.
- *Verified.*

<a id="hardcoded-tab-app-registration"></a>
#### `hardcoded-tab-app-registration` — The tab/page/app system has no registry — adding one means a 4–6 file shotgun edit · **extensibility · HIGH · XL · medium risk**
- **Files:** `index.html:58-128`, `boot.js:5962`/`6365`, `tabs.js:24-51`, `alchemy.js:97`/`792-834`
- **Now:** To add a **tab**: edit `index.html` + `boot.js TOP_TABS` + `applyActiveTab` + `tabs.js MODE_LABEL/ICON_PATHS/locTitle`. To add an **OS page**: `index.html` rail btn + `alchemy.js ALCHEMY_MODES` + the `renderModeContent` if/else + the post-render wiring if/else + `tabs.js` label/icon. To add an **app**: `index.html` + `boot.js APPS_VIEWS` + `openApp`. No manifest. `ICON_PATHS` is even duplicated between `index.html` inline SVG and `tabs.js`. The label tables already carry retired modes.
- **Why:** No compiler/lint catches a missed site → half-wired pages (a tab that switches but has a blank icon/title, or a mode that renders but isn't restorable). New contributors can't discover the edit sites.
- **Proposal:** One `renderer/registry.js` exporting `[{key, kind:'tab'|'mode'|'app', label, iconPaths, render, wire, hint}]`. Generate the rail/app-grid from it; replace both if/else chains with `registry[mode].render()/.wire()`; have `tabs.js` read labels/icons from it. **Incremental:** first source the Sets + label/icon maps from the registry without touching renderers, then fold the dispatch in. *(This is the same `{render,wire,title,icon}` shape the page-split produces — do them together.)*
- *Verified — every touchpoint confirmed, incl. the duplicated icon path.*

<a id="hand-vendored-cross-package-copies"></a>
#### `hand-vendored-cross-package-copies` — Cross-package code hand-vendored because the renderer is unbundled · **maintainability · MEDIUM · M · low risk** ⚠︎ corrected
- **Now:** `shape-ui` and `calendar-ingress-client.mjs` are physically copied into `apps/os/src/vendor` and synced by hand.
- ⚠︎ **Correction:** half the proposed infra **already exists** — `vendor-web.mjs` `syncShapeUi()`/`vendorWeb()` (tested) copies `packages/shape-ui` via `cpSync`, but only targets `apps/web/shape-ui`, **not** the OS vendor dir; and `calendar-ingress-parity.test.mjs` already asserts the calendar-ingress copies agree behaviorally. Also the cited `calendar-ingress.mjs:26` comment is about calendar-ingress, **not** shape-ui. Net: the real gap is just the **OS** shape-ui copy lacking a sync target.
- **Proposal:** Extend the existing `syncShapeUi()` with an OS target (generated + CI-verified), reusing built+tested machinery — smaller than a from-scratch prepack step. (Cross-listed with `os-vendor-shape-ui-unguarded-drift`.)

<a id="renderer-global-coupling-load-order"></a>
#### `renderer-global-coupling-load-order` — Cross-module navigation rides undeclared `window.__srwk*` globals · **maintainability · MEDIUM · M · medium risk**
- **Files:** `boot.js:6384-6386`, `tabs.js:172-186`/`:470`, `alchemy.js:514-1611`
- **Now:** Navigation is wired through `window.__srwkGoTab`/`OpenApp`/`SetNetSub`/`OpenProfile`/`AlchemyJump`/… rather than imports. `tabs.js` calls them behind `typeof window.__srwkGoTab === 'function'` guards — an explicit symptom of **load-order coupling** (the hooks may not be installed when a saved tab is restored). To its credit the namespace is consistent (`__srwk`) and the count is modest (~9 in boot), so it's a contained smell, not chaos.
- **Why:** The inter-subsystem contract is invisible to the module graph — a rename fails only at runtime, and a guard silently no-ops a navigation if boot order shifts.
- **Proposal:** Replace with an imported `renderer/nav.js` exposing `goTab`/`openApp`/`setNetSub`/`openInNewTab`/`openProfile` as real exports, initialized once in boot; drop the `typeof` guards. Keep one frozen `window.__srwk` namespace as a devtools escape hatch if wanted. **Subsumed by the boot.js-router extraction.**
- *Verified* (⚠︎ ~9 not ~15 `__srwk` refs in boot).

<a id="stale-normalize-tables-and-dead-modes"></a>
#### `stale-normalize-tables-and-dead-modes` — Mode/label tables carry retired entries · **dead-code · LOW · S · low risk** ⚠︎ corrected
- **Now:** `renderFeed`/`renderPulse` still wired in `renderModeContent` for modes not in `ALCHEMY_MODES` and unreachable from the rail (comments flag them "kept until we have a real signal"). `normalizeLocation` carries permanent migration shims (`pulse→shapes`, `intel→context`, `calendar2→calendar`).
- ⚠︎ **Correction:** `MODE_LABEL` has the stale `'icons'` entry but **not** `'pulse'` (auditor misread).
- **Proposal:** When the registry lands, parked renderers simply aren't registered (git preserves them). Keep the `normalizeLocation` shims (they protect users' saved tabs) but date-comment them "safe to drop after \<date\>."

**Verifier-added (architecture):**
- `persisted-ls-shape-fourth-copy` — **MEDIUM.** The surface shape is *also* hand-listed in `cohort-source.js:_writeSurfaceLs` (LS snapshot, `:122-153`) and again in `emptyShape()` (`:155`) — a 4th & 5th copy **inside the same file**. A new field forgotten in `_writeSurfaceLs` silently won't survive a reboot's first paint. Drive all three (`emptyShape`, `normalize`, `_writeSurfaceLs`) from one ordered field-descriptor list. → folds into `cohort-model`.
- `shape-ui-os-vendor-not-auto-synced` — concrete restatement of the OS-vendor sync gap (see drift finding).

---

## Suggested sequencing (epics)

1. **Tooling floor** (P0): glob test runner + CI test job → then staged ESLint/Prettier/`@ts-check`. *Unblocks safe refactoring of everything else.*
2. **Stop the cross-package bleeding** (P0→P1): freeze shape-ui drift (all-13 parity test) → reconcile → generate the OS vendor copy; add the calendar-ingress byte test.
3. **`packages/cohort-model`** (P1): parse + shape + memoized read-model, consumed by build-bundles + OS + web. Collapses `triplicated-surface-parse-and-shape`, `no-shared-read-model`, `cohort-index-unmemoized`, `persisted-ls-shape-fourth-copy`, and deletes the parity-test treadmill.
4. **`scripts/lib/{cli,io,google-calendar}.cjs`** (P1): collapse the plumbing duplication; standardize on `parseArgs`.
5. **Electron hardening pass** (P1): nav guards + CSP + IPC `validate()` + sandbox decision + link-egress gating + swf-node LAN-trust toggle, as one reviewable epic.
6. **Performance quick wins** (P0/P1): rubiks dispose, rAF visibility pause, GLB optimization, easel transferables.
7. **Registry + mega-file split** (P2): page registry ⇄ `renderer/pages/*` + `renderer/nav.js`; then `main.js` and `build-bundles.js` extractions. Page-by-page, smoke-tested.

---

## Appendix — ground-truth numbers (independently verified)

- **shape-ui drift:** 8/13 files byte-identical; **5 drifted** (`shape-canvas.js`, `cohort-calendar-week.js`, `cohort-calendar-week.css`, `tokens.css`, `index.js`). Both `shape-canvas` copies last edited in the same commit.
- **scripts plumbing dup:** `arg()` ×45 · `usage()` ×51 · `readJson/writeJson` ×27 · `flag()` ×19 · `resolveGoogleAccessToken` ×10 · `googleRequest` ×6 · 17 scripts hand-build Google URLs · 22/69 scripts run `main()` unguarded.
- **FNV-1a hash:** reimplemented 11×. **HTML-escape:** ~7 local variants, several missing single-quote escaping.
- **IPC handlers:** 101 (55 main + 46 daybook), two naming conventions.
- **Renderer globals:** ~22 distinct `window.__srwk*` hooks as the inter-module bus; `index.html` loads only `boot.js` (+ 3d-force-graph UMD).
- **File sizes:** `alchemy.js` 15,614 / `boot.js` 9,437 / `atlas.js` 5,997 / `build-bundles.js` 2,397 / `main.js` 2,179 lines. `membrane.css` 2,470 lines/80 KB. `rubiks_cube.glb` 8,003,580 bytes (5.86× the 1.37 MB Draco source; 1.74 MB dead UVs; 85k tris).
- **Tests:** 50-file hand-listed suite, currently 50/50 on disk, **runs in no CI**; `apps/os` has **0** test files.
- **Tooling configs present:** none (no eslint/prettier/tsconfig/editorconfig).

---

*Audit performed 2026-06-16 via multi-agent fan-out (16 agents, ~1.67M tokens) with per-finding adversarial verification. All file:line citations and counts above were re-checked against the working tree.*

---

## Implementation log — 2026-06-16 (Tier 1 zero-risk pass)

Landed (working tree only — **not committed/pushed**):

- ✅ **`handmaintained-test-list`** — root `package.json` `test` is now `node --test "scripts/**/*.test.js" "scripts/**/*.test.mjs"`. Verified the glob resolves to exactly the same 50 files (now 51 incl. the new parity test); behavior-neutral. New `*.test.*` files auto-enroll.
- ✅ **`dead-vendor-web-js`** — deleted `scripts/vendor-web.js` (re-confirmed zero code/CI/script references).
- ✅ **`vendor-calendar-ingress-no-byte-parity-test`** — added `scripts/calendar-ingress-vendor-parity.test.mjs` (passes; the two copies are byte-identical today). Auto-discovered by the new glob.
- ✅ **`manual-only-scripts-undocumented` + `esm-cjs-split-undocumented`** — added `scripts/README.md` (module-system convention + operator-only scripts).
- ✅ **tooling baseline** — added `.editorconfig`. *(ESLint/Prettier/`tsc --checkJs` deferred — they need devDeps + rule decisions + CI wiring, which is not zero-risk; see `no-lint-format-typecheck`.)*
- ✅ **`web-app-no-csp`** — added `Content-Security-Policy-Report-Only` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` to `apps/web/vercel.json`. Report-only cannot block anything; flip to enforced `Content-Security-Policy` after a clean reporting window. `vendor-web.test.mjs` still passes (buildCommand/outputDirectory/installCommand untouched).

**Deferred — `unit-tests-not-in-ci` is NOT a zero-risk drop-in (discovered during this pass):**
`npm test` is **not green in a bare checkout** — 2 failures, both **local generated-artifact** issues, not committed defects:
1. `web-calendar-links.test.mjs` imports `apps/web/shape-ui/src/cohort-calendar-week.js`, which is gitignored and only exists after `npm run vendor:web`.
2. `transcript-surface-leak-scan.test.mjs` flags a transcript timecode in the **generated** `apps/web/cohort-surface.json` (gitignored; the timecode is **not** in tracked `cohort-data`, so it's a stale local build artifact, not a committed leak).

To wire the suite into CI safely, the test job must first run `npm run vendor:web` (and a fresh `npm run build:cohort`) to materialize the generated surfaces, then `npm test` — and the job should pin **Node ≥22** (the glob `--test` discovery and the suite were verified on v22.14.0; CI's other steps use Node 20). That's real CI setup, not a drop-in, so it's left for a deliberate follow-up.

Net test result after this pass: **295 tests, 293 pass, 2 pre-existing (local-only) fails** — zero new failures introduced.*
