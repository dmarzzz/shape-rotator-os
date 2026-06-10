# Shape Rotator OS architecture audit findings

Audit date: 2026-06-10
Confidence scale: high means directly evidenced by current code, checks, and git history; moderate means strongly indicated but would benefit from runtime/product-owner confirmation; low means hypothesis.

Freddmannen-only merge rule: this audit belongs to Fred's fork/version. Do not merge this audit section, or PR it, into `dmarzzz/shape-rotator-os`.

## Verdict

Confidence: high.

The project is not hopeless spaghetti, but the risk is real and concentrated. The repo has a plausible product split and several useful build gates. The architecture problem is that the highest-velocity product work is landing in a few very large files that now act as merge-conflict magnets and undocumented integration points.

The most important conclusion: do not start by rewriting the system. Start by freezing the top-level boundaries, adding architectural guardrails, and extracting only along existing seams. The immediate problem is uncontrolled growth in `alchemy.js`, `styles.css`, `boot.js`, and `main.js`, not the mere existence of an Electron app, static web app, or markdown-data pipeline.

## Finding 1: The Electron renderer has a god module

Confidence: high.

Primary evidence:

- `apps/os/src/renderer/alchemy.js` is 13,532 lines.
- It changed in 79 commits since 2026-05-01 with 14,433 additions/deletions.
- It owns mode routing, state, derived models, rendering, DOM event wiring, localStorage persistence, GitHub feed fetching, profile editing, YAML generation, local sync writes, GitHub PR fallback, Context Vault UI, asks, onboarding, program rendering, calendar export, and constellation variants.
- Commit history includes repeated `fix(mega)` recovery commits after merge resolution on 2026-06-08, including restored dropped variables and rendering helpers.

Why this is bad:

- PRs that touch unrelated features still collide in one file.
- Feature boundaries are implicit in comment sections, not enforced by modules.
- The code mixes pure model derivation with side-effectful rendering and network calls, so small UI changes can break unrelated data paths.
- Rebase/merge resolution is already proven dangerous by the recent `fix(mega)` commits.

Architectural classification: high-priority decomposition target.

Do not fix by splitting randomly. Split by stable product mode boundaries already present in the file: `profile`, `constellation`, `asks`, `context`, `program`, `onboarding`, and `calendar`.

## Finding 2: The global stylesheet is an append-only override stack

Confidence: high.

Primary evidence:

- `apps/os/src/styles.css` is 19,651 lines.
- It changed in 77 commits since 2026-05-01 with 16,445 additions/deletions.
- It contains many legacy/cascade comments and late-file override sections.
- It maps legacy variables to newer canonical tokens and contains multiple mode-specific overlays.

Why this is bad:

- CSS ordering has become an architectural dependency.
- New fixes are likely to be appended near the end to win specificity.
- The stylesheet encodes product architecture indirectly through selectors instead of per-mode style modules.
- Visual regressions are hard to localize because changes are globally visible.

Architectural classification: high-priority stylesheet modularization target.

The correct direction is not aesthetic cleanup. It is to split CSS by owned surface and install a token/override policy: base tokens, shell chrome, shared components, per-mode sheets, final compatibility sheet.

## Finding 3: `boot.js` is no longer just boot

Confidence: high.

Primary evidence:

- `apps/os/src/renderer/boot.js` is 9,190 lines.
- It imports the main modes and directly owns network panels, SSE event subscription, graph reconciliation, peer panels, sync-log polling, traffic panel rendering, router/tickets/receipts legacy panels, swarm panel wiring, and keyboard shortcuts.
- It contains comments identifying no-op stubs and archived legacy paths.

Why this is bad:

- The entrypoint has become an application framework without framework-level boundaries.
- Network/event observability logic is co-located with graph bootstrapping and legacy UI.
- It is difficult to know whether a behavior belongs in `boot.js`, `alchemy.js`, `sync-client.js`, `tabs.js`, or a new module.

Architectural classification: high-priority orchestration cleanup.

The target shape should be a small app bootstrapper that wires capability modules. The network tab, events panel, update chip, swarm panel, and legacy archived modes should be independently mountable modules.

## Finding 4: Electron main process is overloaded

Confidence: high.

Primary evidence:

- `apps/os/main.js` is 1,954 lines.
- It registers many IPC handlers and owns userData migration, prefs, Context Vault scanning/indexing, shell/clipboard, daemon supervision, swarm, easel/NDI, update checking/download, app info, and calendar export.
- It duplicates Context Vault/article-generation logic that also exists in `scripts/build-context-vault-corpus.js`.

Why this is bad:

- Main process privilege is broad and not organized by least-capability module.
- It is hard to test main-process behaviors in isolation.
- Adding one feature increases risk to unrelated privileged features such as shell/open/download/export.

Architectural classification: medium-high extraction target.

The first cut should be by IPC namespace: `context-vault`, `updates`, `daemon`, `swarm`, `easel`, `exports`, `prefs`. Each namespace should register handlers from its own module.

## Finding 5: Vendoring/copying is a necessary workaround that has become a drift risk

Confidence: high.

Primary evidence:

- `packages/shape-ui` is the canonical workspace package.
- Electron also has `apps/os/src/vendor/shape-ui`.
- Web has generated `apps/web/shape-ui`.
- The root `vendor:web` script deletes/copies package code into web output.
- `apps/os/scripts/bundle-renderer.cjs` aliases `@shape-rotator/shape-ui` to Electron vendored package code.
- `apps/os/scripts/sync-daybook-vendor.sh` copies Router daybook files.

Why this is bad:

- A developer can patch the wrong physical copy.
- CI can prove one copy builds while another deployed copy is stale.
- Vendored files add noisy search results and make "source of truth" harder to see.

Architectural classification: medium-high build-system debt.

The immediate need is not necessarily to remove vendoring. It is to document the source of truth per vendored tree, add freshness checks, and make stale generated copies fail loudly.

## Finding 6: Runtime data model validation is mostly convention, not enforcement

Confidence: high.

Primary evidence:

- `cohort-data/schema.yml` documents `surface_fields`, controlled vocab, and record shapes.
- `scripts/build-bundles.js` picks whitelisted fields and warns/skips malformed records.
- `apps/os/src/renderer/cohort-source.js` also parses markdown at runtime and silently skips malformed records.
- There is no dedicated schema validation command in package scripts.
- Build output comments reference `docs/SHAPE-ROTATOR-OS-SPEC.md`, but that file is not present in `docs`.

Why this is bad:

- The schema is partly documentation and partly a whitelist, not a strict validator.
- Records with missing/incorrect optional-but-semantic fields can produce subtle UI fallback behavior.
- Missing spec files make code comments and generated comments less trustworthy.

Architectural classification: medium-high data governance debt.

The next guardrail should be `npm run check:schema`, validating record IDs, record types, references, controlled vocab values, duplicate IDs, required fields, and documented enum fields.

## Finding 7: Daybook/Router is better modularized server-side but still has adapter drift pressure

Confidence: moderate-high.

Primary evidence:

- `apps/os/daybook/*` is split into focused modules: transcripts, scope, router, reflect, redact, preferences, postspec, link, intro, draft.
- `apps/os/daybook-main.js` is still a 700-line adapter and IPC registrar.
- `apps/os/src/router/app.js` is a 1,077-line single-file renderer.
- Router channel check passes, but warns that `precompute-ready` has no detected emitter and that `discover-projects` and `link-peer-projects` are extra handlers.

Why this matters:

- The pipeline module split is healthier than the main OS renderer.
- The risk is the copy-based adapter contract and the single-file pop-out UI.
- Current guardrails catch missing invoked IPC handlers, not semantic drift.

Architectural classification: medium debt, not the first fire.

## Finding 8: Direct DOM templating is pervasive

Confidence: high.

Primary evidence:

- Roughly 982 direct DOM/event/template operations across `alchemy.js`, `boot.js`, `atlas.js`, and `router/app.js` using `innerHTML`, `querySelector`, `getElementById`, `addEventListener`, `fetch`, timers, and animation frames.
- The code uses escaping helpers in many places, which is good, but safety relies on discipline across large files.

Why this is bad:

- The project has no component boundary that forces render/update/cleanup lifecycle discipline.
- Event listener rebinding after `innerHTML` replacement is repeated manually.
- XSS safety and DOM consistency are reviewed by convention, not a framework or sanitizer boundary.

Architectural classification: medium-high UI architecture debt.

This does not require adopting React. It does require creating a small local pattern: pure `viewModel` functions, template functions, mount/wire functions, cleanup functions, and tests around template output for risky surfaces.

## Finding 9: Tests exist, but they cover the easy parts

Confidence: high.

Primary evidence:

Passing local checks:

- ICS/calendar tests: 8 passed.
- Model-helper tests: 7 passed.
- Cohort surface freshness: passed.
- ICS freshness: passed.
- Calendar transcript matches: passed.
- Renderer bundle resolution: passed.
- Packaging file coverage: passed.
- Intel data quality: passed.
- Router IPC channel coverage: passed with warnings.

Gap:

- No tests for `alchemy.js` rendering, profile YAML generation in Electron, sync-vs-PR behavior, Context Vault UI behavior, boot network panels, Atlas rendering state, or main-process IPC handlers.
- No architectural budget tests.
- No routine PR Electron smoke test.

Architectural classification: test coverage is useful but misaligned with risk.

The highest-risk files have the least direct coverage.

## Finding 10: Workspace hygiene is leaking generated/runtime sludge

Confidence: high.

Primary evidence:

- Pre-existing `git status` showed modified `package-lock.json`, untracked `.claude/`, and untracked `tmp/`.
- `tmp/` contains many Electron/browser runtime cache files.
- `.gitignore` ignores screenshots and generated web outputs, but not `.claude/` or `tmp/`.

Why this matters:

- Search, metrics, and human review get polluted.
- Accidental `git add .` is dangerous.
- Generated/runtime clutter makes audits slower and noisier.

Architectural classification: low-effort hygiene fix, but not part of this audit implementation.

## Finding 11: Some docs and code comments point at missing or stale specs

Confidence: high.

Primary evidence:

- `cohort-data/schema.yml`, `scripts/build-bundles.js`, generated `apps/os/src/cohort-surface.json`, and `apps/os/src/renderer/cohort-source.js` reference `docs/SHAPE-ROTATOR-OS-SPEC.md`.
- `docs/SHAPE-ROTATOR-OS-SPEC.md` is absent.
- `docs/MATURITY.md` and `docs/INSTALL.md` reference `docs/SYNC.md` or swf-node `SYNC.md`; no local `docs/SYNC.md` exists.

Why this matters:

- New contributors cannot tell whether the spec moved, was deleted, or was never committed.
- Generated files claim provenance that cannot be followed.
- Spec drift was already called out repeatedly in `docs/MATURITY.md`.

Architectural classification: documentation integrity debt.

## Finding 12: There is already evidence of merge-driven regression

Confidence: high.

Primary evidence:

The git log includes multiple recovery commits on 2026-06-08:

- `fix(mega): re-wire card clicks after shapes filter switch`
- `fix(mega): restore #203 detail helpers`
- `fix(mega): restore #226 constellation board template + journey assessedTeams + membrane graphEdges/allEdges at fn scope`
- `fix(mega): restore dropped graphEdges + teamById in computeMembraneData`
- `fix(mega): restore dropped 'const delta' in renderConstellation`
- `fix(mega): restore dropped 'const renderSeq' capture in render()`

Why this matters:

This is the strongest evidence that the problem is architectural, not just subjective. The project has already had PR merge paths that dropped behavior from massive files. The fix is not better human attention. The fix is smaller ownership units, better tests around hot paths, and merge-conflict budgets.

## Non-findings

These are not the main problem:

- The npm workspace structure is not inherently bad.
- Electron is not inherently the problem.
- Markdown as source of truth is not inherently the problem.
- Vendoring is not automatically wrong given Electron packaging constraints.
- The app has real guardrails; it is not totally uncontrolled.

The problem is concentration of responsibilities plus insufficient boundary checks around the hottest files.
