# Shape Rotator OS architecture map

Audit date: 2026-06-10
Branch audited: `codex/fix-collab-constellation-nav`
HEAD audited: `523ba15`
Scope: current working tree, excluding `node_modules`, `.git`, `.claude/worktrees`, `tmp`, generated web vendor output, vendored third-party renderer code, generated cohort JSON, and raw transcript text for source-size metrics.

Freddmannen-only merge rule: this audit belongs to Fred's fork/version. Do not merge this audit section, or PR it, into `dmarzzz/shape-rotator-os`.

## Executive map

Shape Rotator OS is not one app. It is four systems sharing one repo:

1. Electron desktop app under `apps/os`.
2. Static web site under `apps/web`.
3. Shared browser UI package under `packages/shape-ui`.
4. Markdown/YAML cohort data product under `cohort-data`, with build scripts in `scripts`.

That split is reasonable. The architecture debt is that implementation boundaries do not match those product boundaries. The Electron renderer, Electron main process, generated data, vendored UI, and static web outputs repeatedly duplicate or cross over each other.

## Repository domains

| Domain | Main paths | Current responsibility | Architecture note |
|---|---|---|---|
| Desktop shell | `apps/os/main.js`, `apps/os/preload.js`, `apps/os/src/index.html`, `apps/os/src/renderer/*`, `apps/os/src/styles.css` | Electron window lifecycle, IPC, update flow, daemon supervision, WebGL, cohort UI, profile editing, network panels, atlas, constellation, easel, router launcher | Largest sprawl concentration. Most product modes converge into one renderer entry and one stylesheet. |
| Router pop-out | `apps/os/daybook-main.js`, `apps/os/daybook/*`, `apps/os/src/router/*` | Teleport Router onboarding/digest/posting flow, local transcript collection, redaction, voice, feed, device linking | Better modularized server-side than the main OS renderer, but the pop-out app itself is a single large DOM controller. |
| Static web | `apps/web/*`, `apps/web/scripts/*`, generated `apps/web/shape-ui`, generated `apps/web/cohort-surface.json` | Public install page, cohort pages, calendar, availability, journal pages | Depends on vendoring/copy steps instead of clean package consumption at deploy time. |
| Shared UI | `packages/shape-ui/src/*` | Calendar, availability, cards, profile form, link helpers, shape canvas, tokens | Good candidate for shared extraction, but Electron and web also carry generated copies. |
| Cohort data | `cohort-data/**/*.md`, `cohort-data/schema.yml`, `cohort-data/calendar.json`, `cohort-data/timeline.yml` | Source of truth for people, teams, dependencies, asks, events, clusters, program pages, calendar mirror | Schema is documented and consumed, but enforcement is partial and convention-heavy. |
| Build scripts | `scripts/*.js`, `apps/os/scripts/*.cjs` | Build read models, publish bundles, generate calendar ICS, package checks, renderer bundle check, binary staging | Contains useful gates; some parsing and model logic is duplicated with runtime code. |
| CI/release | `.github/workflows/*.yml` | PR checks, release builds, calendar sync, conflict watch | PR checks are real but narrow. Release flow has stronger packaging checks than PR flow. |

## Main data flows

### 1. Markdown data to desktop and web

Source data lives in `cohort-data`.

`scripts/build-bundles.js` parses markdown frontmatter, picks public `surface_fields` from `cohort-data/schema.yml`, and writes `apps/os/src/cohort-surface.json`.

`npm run vendor:web` copies `packages/shape-ui` into `apps/web/shape-ui`, copies `apps/os/src/cohort-surface.json` into `apps/web/cohort-surface.json`, and copies calendar artifacts into `apps/web`.

Runtime consumers:

- Desktop renderer reads bundled `apps/os/src/cohort-surface.json`, then `apps/os/src/renderer/cohort-source.js` can refresh via GitHub and merge sync envelopes.
- Web pages fetch `/cohort-surface.json` and import from the vendored `apps/web/shape-ui/src/index.js`.

Risk: one logical data model has at least three physical materializations: markdown source, Electron generated JSON, and web vendored generated JSON. The build scripts keep them current, but drift is easy when someone edits generated output or skips vendor steps.

### 2. Electron main to renderer

`apps/os/main.js` creates the main window, migrates legacy user data, supervises `swf-node`, handles update/download flows, scans the Context Vault, manages swarm/easel IPC, and exports calendar files.

`apps/os/preload.js` exposes `window.api` with broad capabilities: preferences, context vault, clipboard, updates, daemon status, swarm, easel/NDI, and daybook window opening.

`apps/os/src/renderer/boot.js` is the main renderer entry. It imports Three, graph/render helpers, Atlas, Easel, Alchemy, Tabs, Find, sync-client, and cohort-source. It also owns multiple network panels and legacy surfaces.

Risk: main-process privilege boundaries are not organized by capability module. A single file is both the app bootstrapper and a large portion of the backend application layer.

### 3. Alchemy/cohort surface

`apps/os/src/renderer/alchemy.js` is the largest product controller. It owns:

- Mode routing for `membrane`, `shapes`, `constellation`, `intel`, `calendar`, `profile`, `onboarding`, `program`, `asks`, and `context`.
- Cohort loading and timeline loading.
- Membrane data derivation.
- Constellation map/ring/journey/stack/collab views.
- Onboarding modal and operator-stub flows.
- Markdown rendering for program/context content.
- Asks rendering and ask markdown generation.
- Context Vault UI and article/ask/program markdown generation.
- Atlas tag layout inside the alchemy surface.
- Calendar export.
- Team/person detail drawers.
- GitHub event feed.
- Profile editor, YAML generation, sync write, GitHub PR fallback.

Risk: this is a god module. It is not just large; it mixes product routing, derived models, view templates, persistence, network calls, markdown generation, local sync, GitHub fallback, and detailed DOM wiring.

### 4. Atlas

`apps/os/src/renderer/atlas.js` is a standalone canvas/WebGL-ish map renderer with its own state object, pointer handling, render loop, coastlines/watercolor wash, topic naming, topic clustering, truncated SVD, k-means, and MDS.

Risk: the file is internally sectioned and more cohesive than `alchemy.js`, but it contains a full visualization engine plus clustering pipeline in one module. It is high-change-risk because rendering, interaction, data prep, and ML-ish transforms live together.

### 5. Router/daybook pop-out

`apps/os/daybook-main.js` registers 43 shim-invoked IPC handlers and adapts the vendored Router pop-out to local OS services.

`apps/os/src/router/preload.js` exposes `window.daybook`.

`apps/os/src/router/app.js` is a single-file pop-out UI controller for identity joining, introduction interview, voice capture, draft generation, scope manager, feed, and device linking.

`apps/os/scripts/sync-daybook-vendor.sh` copies upstream Router files into this repo. `apps/os/scripts/check-router-channels.cjs` checks adapter coverage.

Risk: adapter coverage is guarded, but the vendoring model is still copy-based. Channel coverage passes today, but the current check warns that the shim listens for `precompute-ready` without a detected emitter and that adapter handlers `discover-projects` and `link-peer-projects` are not invoked by the shim.

### 6. Packaging/release

`apps/os/package.json` packages Electron and stages `swf-node`, `research-swarm`, `cohort-keys.json`, and `whisper` resources.

Release workflow:

- Installs dependencies.
- Strips mac-only NDI module on non-mac runners.
- Checks packaging file coverage.
- Fetches/stages daemon binaries.
- Rebuilds cohort surface.
- Runs renderer bundle check.
- Builds platform installers.
- Runs mac packaged smoke only in release path.

Risk: release checks are stronger than PR checks. PR checks do not run packaging coverage, router-channel coverage, ICS tests, model tests, or Electron smoke.

## Source-size hot spots

Current line counts from the audited tree:

| File | Lines | Why it matters |
|---|---:|---|
| `apps/os/src/styles.css` | 19,651 | Global cascade for nearly every desktop surface. Append-only override layers and legacy aliases are now a structural risk. |
| `apps/os/src/renderer/alchemy.js` | 13,532 | Main god module for cohort UI, modes, profile editor, asks, context vault, constellation, calendar, sync, PR fallback. |
| `apps/os/src/renderer/boot.js` | 9,190 | Renderer bootstrap plus graph, network, events, router/tickets/receipts legacy panels, swarm panel, keyboard wiring. |
| `apps/os/src/renderer/atlas.js` | 5,993 | Canvas map renderer plus clustering/name extraction pipeline. |
| `apps/os/src/renderer/intel/intel-data.js` | 3,585 | Large static content/data payload in source. |
| `apps/os/main.js` | 1,954 | Electron main bootstrap plus Context Vault, IPC, updates, daemon, swarm, easel, export. |
| `packages/shape-ui/src/cohort-calendar-week.css` | 1,440 | Shared UI CSS that also has Electron legacy resets. |
| `packages/shape-ui/src/cohort-calendar-week.js` | 1,146 | Shared calendar renderer and behavior. |
| `apps/os/src/router/app.js` | 1,077 | Single-file Router pop-out UI. |
| `apps/os/src/index.html` | 970 | Large static DOM shell with multiple hidden panels and legacy IDs. |

Current source metrics, excluding generated/vendor/raw-transcript/runtime directories:

| Extension | Files | Lines |
|---|---:|---:|
| `.js` | 85 | 56,838 |
| `.css` | 11 | 25,954 |
| `.md` | 132 | 6,563 |
| `.html` | 13 | 3,662 |
| `.yml` | 6 | 847 |
| `.cjs` | 6 | 627 |
| `.json` | 6 | 379 |
| `.mjs` | 2 | 262 |

## Churn hot spots

Since 2026-05-01, current source files with the highest churn:

| Path | Additions + deletions | Commits |
|---|---:|---:|
| `apps/os/src/styles.css` | 16,445 | 77 |
| `apps/os/src/renderer/alchemy.js` | 14,433 | 79 |
| `apps/os/src/renderer/intel/intel-data.js` | 6,605 | 2 |
| `apps/os/src/renderer/boot.js` | 3,749 | 30 |
| `packages/shape-ui/src/cohort-calendar-week.css` | 2,593 | 19 |
| `packages/shape-ui/src/cohort-calendar-week.js` | 2,078 | 19 |
| `apps/os/src/renderer/membrane/membrane.css` | 1,894 | 18 |
| `apps/os/src/renderer/membrane/index.js` | 1,806 | 18 |
| `apps/os/main.js` | 1,622 | 20 |
| `apps/web/styles/web.css` | 1,550 | 14 |
| `apps/web/scripts/cohort.js` | 1,484 | 13 |
| `apps/os/src/router/app.js` | 1,153 | 1 |
| `apps/os/src/renderer/easel.js` | 1,025 | 10 |
| `packages/shape-ui/src/cohort-calendar.js` | 979 | 10 |
| `scripts/build-bundles.js` | 767 | 10 |

This is the central architectural smell: the largest files are also the hottest files. That is where PRs will collide, where merge conflict resolution will drop behavior, and where regression tests need to be strongest.

## Current guardrails

Passing locally on 2026-06-10:

- `npm test`: 8 calendar/ICS tests passed.
- `npm run test:models`: 7 model/helper tests passed.
- `npm run check:cohort`: cohort surface JSON up to date.
- `npm run check:ics`: ICS output up to date.
- `npm run check:calendar-transcripts`: 14 matches, 12 unique sources, passed.
- `npm --workspace @shape-rotator/os run bundle:check`: 66 modules, 3.39 MB bundle, passed.
- `npm --workspace @shape-rotator/os run check:packaging`: 18 required main-process files covered.
- `npm --workspace @shape-rotator/os run check:intel`: 6 coordinator-move headline signals, passed.
- `node apps/os/scripts/check-router-channels.cjs`: all 43 invoked channels handled; warning for one missing emitter and two unused handlers.

Current gaps:

- No general lint/typecheck.
- No unit coverage for `alchemy.js`, `boot.js`, `atlas.js`, or `main.js`.
- No DOM snapshot tests for major render modes.
- No architectural budget check for file size, module imports, direct DOM mutation, or churn.
- Electron smoke is release-path mac-only, not a routine PR gate.

## Workspace hygiene at audit start

Pre-existing working tree state before audit docs were added:

- Branch: `codex/fix-collab-constellation-nav`.
- `package-lock.json` modified with 14 changed lines.
- `.claude/` untracked.
- `tmp/` untracked, containing many Electron/browser cache files.

The repo `.gitignore` ignores screenshots and generated web vendor outputs, but it does not ignore `.claude/` or `tmp/`.
