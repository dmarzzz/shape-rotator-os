# Shape Rotator OS audit addendum: missed pieces

Audit date: 2026-06-10
Branch audited: `codex/fix-collab-constellation-nav`
HEAD audited: `523ba15`
Purpose: second-pass architecture audit focused on areas not covered deeply enough in the first three audit docs.

No source fixes were made in this pass. This document maps additional risk.

Freddmannen-only merge rule: this audit belongs to Fred's fork/version. Do not merge this audit section, or PR it, into `dmarzzz/shape-rotator-os`.

## Summary

Confidence: high.

The first audit correctly identified the main concentration problem: `alchemy.js`, `styles.css`, `boot.js`, and `main.js`. This addendum changes the emphasis in five ways:

1. The Electron privilege model is not catastrophically unsafe, but it is too coarse. The Hermes window receives the same full `window.api` preload as the main OS window, and the main preload exposes unrelated privileged capabilities through one global object.
2. The Router/daybook privacy architecture is more deliberate than the rest of the app, but its comments and implementation have drifted. The code no longer fail-closes whole conversations on low-confidence secret-shaped hits, while several comments still say it does.
3. CI and release automation are useful but uneven. Release packaging has stronger gates than ordinary PR checks, and several existing local guards are not in CI.
4. Shared UI and web deploy artifacts are intentionally copied/ignored, but there is no freshness gate. That makes deploy correctness dependent on remembering the right copy ritual.
5. The cohort data layer has basic hygiene, but not schema-grade validation. A few concrete referential gaps already show why a strict check is needed.

## Finding A1: Electron window privilege is coarse-grained

Confidence: high.

Evidence:

- Main window: `apps/os/main.js` creates the primary `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: false`.
- Hermes window: `apps/os/main.js` creates the Hermes PoC window with the same `apps/os/preload.js`.
- Router window: `apps/os/daybook-main.js` creates a separate window with `apps/os/src/router/preload.js`, `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: false`.
- `apps/os/preload.js` exposes one broad `window.api` object containing preferences, Context Vault reads, raw bundle reads, clipboard writes, update install/download paths, local daemon status, agent bearer token access, swarm start/stop/config, NDI/easel capture and projection, and Router window launch.

Why this matters:

- `contextIsolation` and disabled `nodeIntegration` are good, but `sandbox: false` plus a broad preload means the effective security boundary is the preload API shape.
- The Hermes PoC does not need Context Vault raw reads, update install actions, swf-agent tokens, swarm control, or NDI/easel APIs. It receives them anyway because it uses the same preload.
- A renderer-side XSS or dynamic-template mistake in any page using `preload.js` would have access to every exposed capability, not just the capability needed by that page.

Architecture classification: high-priority capability split.

Recommended direction:

- Split `apps/os/preload.js` into page-specific preloads or capability-specific bridges:
  - `main-preload.js`
  - `hermes-preload.js`
  - `context-vault-preload.js` if needed
  - `easel-preload.js` if easel becomes a separate surface
- Register IPC by namespace and expose only the namespace needed by the page.
- Treat `getSwfAgentToken`, update installer actions, raw Context Vault reads, and NDI/easel APIs as privileged capabilities, not ordinary renderer helpers.

## Finding A2: Navigation and external-open policy is not centralized

Confidence: moderate-high.

Evidence:

- I found no `setWindowOpenHandler` or `will-navigate` policy in the Electron window setup.
- The main app's `shell:openExternal` handler accepts only `http` and `https`, which is a good local guard.
- `shell:openDownloadedInstaller` validates that the target is inside Downloads and has an allowed installer extension.
- The Router adapter's `open-feed` handler calls `shell.openExternal((server || DEFAULT_SERVER).replace(/\/$/, ""))` without the same scheme validation.

Why this matters:

- The content loaded today is local `loadFile` content, so this is not an immediate web-content exposure.
- But the project uses a lot of dynamic `innerHTML` and many external links. Central navigation policy would make the rule explicit instead of relying on each handler.
- The main app already has one safer external-open path; Router has a looser one.

Architecture classification: medium-high Electron hardening.

Recommended direction:

- Add a shared `safeOpenExternal(url)` helper in main-process code.
- Route every external-open IPC path through it.
- Add window-level navigation policy:
  - deny unexpected top-level navigation from local files;
  - deny or route new-window requests through `safeOpenExternal`;
  - log denied schemes.

## Finding A3: Manual update download path lacks explicit integrity verification

Confidence: moderate.

Evidence:

- `fg:download-and-reveal-update` resolves the latest version via `electron-updater`, constructs a GitHub release asset URL from naming conventions, streams it to Downloads, then opens or reveals it.
- The function intentionally avoids `api.github.com` and uses the release naming convention.
- I did not find explicit checksum verification in that manual download path before `shell.openPath` or `showItemInFolder`.

Why this matters:

- The auto-updater path has its own feed/integrity machinery.
- The manual path is for cases where auto-update is not viable, especially unsigned macOS builds, but it also constructs and downloads installer assets directly.
- Without an explicit hash/signature check, correctness depends on GitHub release asset integrity plus the version/feed convention.

Architecture classification: medium release hardening.

Recommended direction:

- Reuse the checksum from the updater feed if available, or publish a manifest with asset SHA-256 values.
- Verify before opening/revealing.
- Add a release check that asserts every published asset named by the updater feed exists and matches the expected checksum.

## Finding A4: Router/daybook privacy comments and implementation have drifted

Confidence: high.

Evidence:

- `apps/os/daybook/transcripts.js` top comments say secret-shaped but unclassifiable sessions are "HELD out and surfaced, never silently sent".
- `redact.js` also describes low-confidence/high-entropy content as something callers can fail closed on.
- But `buildDigest()` currently says:
  - "We no longer 'hold' whole conversations on a low-confidence/high-entropy hit..."
  - it masks findings, pushes findings, and continues;
  - it initializes `held = []` and does not push held sessions.

Why this matters:

- The privacy architecture is unusually explicit and should be preserved.
- The current behavior may be an intentional product change to reduce false-positive holds.
- The problem is that the invariant text now overclaims. Reviewers may believe the system still fail-closes whole sessions when it does not.

Architecture classification: high-priority documentation/contract drift.

Recommended direction:

- Decide the actual invariant:
  - either restore fail-closed holds for low-confidence `suspect` results;
  - or update the invariant language to "mask and surface findings, but do not hold whole conversations on low-confidence entropy".
- Add tests for:
  - known API keys are masked;
  - user hide terms are masked;
  - low-confidence entropy behavior matches the chosen policy;
  - `collectToday`, `collectRecent`, SSH recent, direct-link raw, and `post` all pass through the same redaction rules.

## Finding A5: Router/daybook is modular, but its egress contract is still hand-wired

Confidence: high.

Evidence:

- `apps/os/daybook/*` is split into focused modules: `transcripts`, `scope`, `redact`, `reflect`, `router`, `link`, `draft`, `intro`, `preferences`, `postspec`.
- `apps/os/daybook-main.js` registers a broad set of IPC handlers for identity, joining, model-driven draft generation, posting, link host/client operations, SSH raw pulls, scope mutations, and redaction reveal.
- `apps/os/src/router/preload.js` exposes the full Router surface under `window.daybook`.
- `apps/os/scripts/check-router-channels.cjs` exists and passed locally, but it is not part of `.github/workflows/os-pr-checks.yml`.
- The channel check warned that `precompute-ready` has no detected emitter, while `discover-projects` and `link-peer-projects` are adapter handlers unused by the shim.

Why this matters:

- The module split is much healthier than `alchemy.js`.
- The drift risk is at the adapter boundary: vendored renderer/preload methods, daybook-main handlers, and the privacy egress routes have to remain aligned by convention.
- A channel coverage check catches missing IPC handlers but not whether every egress path still passes through scope and redaction.

Architecture classification: medium-high contract hardening.

Recommended direction:

- Add `node apps/os/scripts/check-router-channels.cjs` to PR CI.
- Add an egress inventory test that enumerates Router actions capable of sending data out:
  - `post`
  - direct link recent/raw
  - SSH recent/raw
  - feed/open external
  - identity/register/join
- For each egress action, test or assert the required gate: scope, redaction, user approval, or safe URL.

## Finding A6: Direct device link is intentionally plain TCP, not encrypted transport

Confidence: high.

Evidence:

- `apps/os/daybook/VENDOR.md` describes device link as plaintext TCP pairing with a shared secret in the pairing code.
- `apps/os/daybook/link.js` implements newline-delimited JSON over TCP, authenticating with a shared secret.
- The same file also supports SSH, using existing SSH key access.

Why this matters:

- This is not hidden; the vendoring doc states it.
- But it is a product/security boundary that deserves to be explicit in the app architecture docs and review checklist.
- Shared-secret auth over plaintext LAN can be acceptable for a trusted LAN workflow, but it is not the same as an encrypted transport.

Architecture classification: medium security/product contract debt.

Recommended direction:

- Make the UI and docs say "LAN plaintext with shared secret" plainly.
- Keep raw sharing off by default.
- Consider TLS/noise-style transport only if direct link becomes internet-facing or higher-trust data moves over it.

## Finding A7: Release automation degrades too quietly

Confidence: high.

Evidence:

- `scripts/fetch-swf-node.sh` falls back to a stub when upstream release assets are unavailable for some targets.
- `scripts/fetch-research-swarm.sh` falls back to a stub, especially on Windows.
- `scripts/fetch-whisper.sh` uses `set -uo pipefail` rather than `set -euo pipefail` and deliberately exits 0 even when model, whisper, or ffmpeg staging degrades.
- `.github/workflows/os-release.yml` catches some release packaging issues with `check:packaging`, `bundle:check`, and optional mac smoke.
- The release job comments say the pushed tag version must match `apps/os/package.json`, but I found no explicit CI step enforcing tag/package version equality.

Why this matters:

- Graceful degradation may be right for optional capabilities.
- But a passing release can mean "installer built with stubs", not "all advertised capabilities are present".
- Users and maintainers need a release capability manifest, not just a green build.

Architecture classification: medium release correctness debt.

Recommended direction:

- Emit a release manifest per platform/arch:
  - swf-node real/stub/missing;
  - research-swarm real/stub/missing;
  - whisper-cli present/missing;
  - ffmpeg present/missing;
  - NDI present/stripped;
  - signed/notarized status.
- Fail release only for mandatory capabilities; publish degraded optional capability state explicitly.
- Add a tag/package version equality check.
- Pin or checksum external binary sources where practical.

## Finding A8: PR checks are narrower than the real risk surface

Confidence: high.

Evidence:

Current `.github/workflows/os-pr-checks.yml` runs:

- `npm ci --ignore-scripts`
- `npm run check:cohort`
- `npm run check:calendar-transcripts`
- `npm --workspace @shape-rotator/os run check:intel`
- `npm --workspace @shape-rotator/os run bundle:check`

But these locally passing checks are not in PR CI:

- `npm test`
- `npm run test:models`
- `npm run check:ics`
- `npm --workspace @shape-rotator/os run check:packaging`
- `node apps/os/scripts/check-router-channels.cjs`
- `npm --workspace @shape-rotator/os run smoke`

Why this matters:

- The PR gate protects generated cohort freshness and renderer resolution.
- It does not protect packaging file coverage, Router channel coverage, ICS generation, model helper tests, or even a cheap Electron smoke.
- Release has stronger safety gates than normal PRs, so defects can merge and only fail later.

Architecture classification: high-priority CI alignment.

Recommended direction:

- Add the low-cost missing checks to PR CI immediately:
  - `npm test`
  - `npm run test:models`
  - `npm run check:ics`
  - `npm --workspace @shape-rotator/os run check:packaging`
  - `node apps/os/scripts/check-router-channels.cjs`
- Put Electron smoke behind a platform/flake decision. If it is too fragile for every PR, run it on a scheduled workflow and release branches.

## Finding A9: Web deploy artifacts are ignored and freshness is not enforced

Confidence: high.

Evidence:

- Root `.gitignore` intentionally ignores:
  - `apps/web/shape-ui/`
  - `apps/web/cohort-surface.json`
  - `apps/web/calendar.json`
  - `apps/web/calendar.ics`
- `npm run vendor:web` regenerates them with shell commands:
  - `rm -rf apps/web/shape-ui`
  - `cp -R packages/shape-ui apps/web/shape-ui`
  - copy cohort/calendar artifacts into `apps/web`
- `apps/web` has no package.json of its own.
- `npm run deploy:web` runs the root vendor script, then `cd apps/web && vercel deploy --prod --yes`.

Why this matters:

- Ignoring generated deploy artifacts is reasonable.
- But freshness is checked only by remembering to run `vendor:web`.
- The script is POSIX-shell-oriented and less reliable as a cross-platform local workflow from this Windows workspace.
- The web app has no owned package boundary for build/check/deploy commands.

Architecture classification: medium-high web build debt.

Recommended direction:

- Give `apps/web` a minimal package boundary or a root `scripts/vendor-web.js` that is cross-platform Node.
- Add `npm run check:web-vendor`:
  - rebuild into a temp dir;
  - compare ignored deploy artifacts;
  - fail if the deployed tree would differ.
- Keep deploy artifacts ignored if desired, but make drift visible before deploy.

## Finding A10: Shared UI exists in three physical forms

Confidence: high.

Evidence:

- Canonical source: `packages/shape-ui`.
- Electron vendored copy: `apps/os/src/vendor/shape-ui`.
- Web deploy copy: `apps/web/shape-ui`, ignored/generated.
- `git diff --no-index --stat packages/shape-ui/src apps/os/src/vendor/shape-ui` reported differences in `shape-canvas.js` and `tokens.css`.
- `git diff --no-index --stat packages/shape-ui apps/web/shape-ui` reported differences across nine source/style files in the generated web copy at the time of audit.

Why this matters:

- There may be valid reasons for Electron-specific vendoring and generated web deploy output.
- But the repo currently has no automatic answer to "which copy is the source of truth for this bug?"
- A contributor can patch the web generated copy, the Electron vendor copy, or the package, and only one path may ship.

Architecture classification: high-priority generated/vendor guardrail.

Recommended direction:

- Declare the source of truth per file tree in `docs/generated-artifacts.md`.
- Add freshness checks:
  - package -> Electron vendor copy, allowing documented exceptions;
  - package -> web generated copy after `vendor:web`;
  - OS generated cohort surface -> web cohort surface.
- If Electron-specific forks are needed, list exact allowed diffs in a manifest.

## Finding A11: Cohort data has basic hygiene but not strict referential integrity

Confidence: high.

Evidence from direct checks:

- All cohort markdown files have `record_id` and `record_type`.
- No duplicate `record_id` values were detected in cohort-data markdown.
- Record type counts:
  - `article`: 3
  - `ask`: 2
  - `cluster`: 12
  - `dependency`: 9
  - `event`: 12
  - `person`: 53
  - `program_page`: 4
  - `team`: 25
- All dependency `source` and `target` values point at existing team IDs.
- One person primary team reference is unresolved:
  - `cohort-data/people/mikeishiring.md` has `team: flashbots-x`, but no matching team record was found.
- One ask author reference is unresolved:
  - `cohort-data/asks/your-slug-2026-05-18-v0wt.md` has `author: your-slug`, but no matching person/team record was found.

Why this matters:

- These are small data issues, not architectural failures by themselves.
- The architecture problem is that `build-bundles.js` mostly transforms and warns/skips. It does not enforce all references and documented enum-like fields.
- Data quality bugs show up later as UI fallbacks or missing relationships.

Architecture classification: medium-high data validation debt.

Recommended direction:

- Add `npm run check:schema`.
- Validate:
  - required fields by record type;
  - unique IDs;
  - referential fields;
  - enum-ish values documented in `cohort-data/schema.yml`;
  - controlled `skill_areas`;
  - date formats;
  - list/object shapes for known fields.
- Keep `build-bundles.js` focused on building, not being the only validator.

## Finding A12: Generated/spec comments point at absent documents

Confidence: high.

Evidence:

- `docs/SHAPE-ROTATOR-OS-SPEC.md` is absent.
- `docs/SYNC.md` is absent.
- `docs/phase-2-sync-spec.md` is absent.
- `cohort-data/schema.yml`, `scripts/build-bundles.js`, generated `apps/os/src/cohort-surface.json`, generated `apps/web/cohort-surface.json`, and `apps/os/src/renderer/cohort-source.js` reference the missing Shape Rotator OS spec.
- `docs/MATURITY.md`, `docs/INSTALL.md`, `apps/os/swf-node.js`, and `apps/os/src/renderer/sync-client.js` reference missing or external sync spec paths.
- Onboarding UI still includes hard-coded placeholders:
  - `TODO_MATRIX_HOMESERVER`
  - `TODO_MATRIX_ROOM`
  - `TODO_BOT_SETUP_SCRIPT`

Why this matters:

- Missing specs are not just stale docs; they are referenced by generated artifacts that ship to the app/web outputs.
- New contributors cannot trace the intended contract.
- Placeholder onboarding copy means a user can reach a documented workflow that is knowingly incomplete.

Architecture classification: medium-high documentation integrity debt.

Recommended direction:

- Restore the missing spec docs, or update every reference to the current canonical external spec URL.
- Add a docs-link check for internal `docs/*.md` references.
- Remove or feature-gate onboarding placeholder flows until real values are available.

## Finding A13: Static web uses runtime GitHub API calls in user-facing pages

Confidence: moderate.

Evidence:

- `apps/web/scripts/nav.js` fetches GitHub releases at runtime.
- `apps/web/workspace/index.html` fetches GitHub repository contents and commits at runtime.
- The Electron code already contains comments avoiding `api.github.com` in update flows because unauthenticated quota is easy to hit.

Why this matters:

- Static web pages can silently degrade under GitHub API rate limits.
- That may be fine for non-critical workspace/journal previews, but it should be intentional.
- The project already knows API quota is a practical problem.

Architecture classification: medium web reliability debt.

Recommended direction:

- Move stable GitHub-derived page data to build time where possible.
- For dynamic release checks, cache results or degrade with explicit copy.
- Add a web smoke/check that pages do not depend on GitHub API for primary content.

## Finding A14: Tests are almost entirely outside the highest-risk behavior

Confidence: high.

Evidence:

Tracked test-like files found:

- `scripts/build-ics.test.js`
- `scripts/test-model-helpers.mjs`
- `apps/os/daybook/postspec.js`
- `apps/os/scripts/smoke-test.cjs`

The first two are true test commands in package scripts. `postspec.js` is runtime validation/helper logic, not a Node test suite. `smoke-test.cjs` is a runner used by packaging/release paths.

Missing direct tests:

- preload API payload validation;
- main-process IPC handlers;
- `redact.js` detector behavior;
- `scope.js` decision behavior;
- `transcripts.js` egress behavior;
- `link.js` direct/SSH redaction behavior;
- profile YAML/PR generation in Electron;
- `alchemy.js` mode rendering;
- `boot.js` network panels;
- web vendor freshness.

Why this matters:

- The project has tests, but they cover calendar/model-helper work rather than the privacy, IPC, renderer, and packaging boundaries most likely to break under PR churn.

Architecture classification: high-priority test realignment.

Recommended direction:

- Add the first tests where functions are already pure:
  - `redact.js`
  - `scope.js`
  - `postspec.js`
  - data/schema checker
  - profile markdown/YAML helpers after extraction.
- Then add integration checks around IPC inventory and Router egress.

## Finding A15: Versioning has multiple authorities

Confidence: moderate-high.

Evidence:

- Root `package.json` version: `0.1.0`.
- `apps/os/package.json` version: `0.3.0-rc.4`.
- Release workflow comments say tags are v-prefixed and must match `apps/os/package.json`.
- I found no explicit step that compares the pushed tag to the OS package version.

Why this matters:

- Multiple versions are normal in a workspace.
- But the release artifact naming, updater feed, app version, and tag must agree.
- A mismatch can produce confusing update behavior even if packaging succeeds.

Architecture classification: medium release governance debt.

Recommended direction:

- Add a release step:
  - read `apps/os/package.json` version;
  - compare with `GITHUB_REF_NAME` after stripping `v`;
  - fail on mismatch.
- Optionally document root package version as repo/tooling version and OS package version as product version.

## Priority additions to the backlog

These should be added to the existing refactor backlog, in this order:

1. Split Electron preloads by page/capability, starting with Hermes.
2. Centralize safe URL opening and window navigation policy.
3. Resolve the daybook privacy invariant drift around low-confidence `suspect` findings.
4. Add missing local checks to PR CI:
   - tests;
   - ICS check;
   - packaging check;
   - Router channel check.
5. Add `check:schema` for cohort-data referential integrity.
6. Add vendor/generated freshness checks for `shape-ui` and web deploy artifacts.
7. Add release capability manifests for real/stub/missing bundled binaries.
8. Add tag/package version equality enforcement.
9. Restore or rewrite missing spec references.
10. Give `apps/web` an owned build/check boundary, even if it remains static.

## Revised risk ranking after second pass

| Rank | Area | Risk | Confidence |
|---:|---|---|---|
| 1 | `alchemy.js` and `styles.css` hot-file concentration | Merge regressions and uncontrolled product sprawl | High |
| 2 | Broad Electron preload capability surface | Renderer compromise or bug has too much privilege | High |
| 3 | Daybook privacy invariant drift | Reviewers believe stronger fail-closed behavior exists than implementation provides | High |
| 4 | Missing PR checks for existing local guards | Broken packaging/router/channel/schema behavior can merge | High |
| 5 | Vendor/generated copy drift | Fixes land in the wrong physical copy or deploy artifacts go stale | High |
| 6 | Weak data/schema enforcement | Bad references become subtle UI/data bugs | High |
| 7 | Release graceful-degradation opacity | Green release can ship stubs/missing optional capabilities without clear manifest | High |
| 8 | Missing specs/onboarding placeholders | Contributors and users cannot trace intended contracts | High |
| 9 | Static web runtime GitHub API dependency | Web pages degrade under rate limits | Moderate |
| 10 | Router vendoring ritual | Adapter drift depends on remembering manual sync/review steps | Moderate-high |
