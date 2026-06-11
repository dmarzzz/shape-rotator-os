# Shape Rotator OS architecture backlog

Audit date: 2026-06-10
Purpose: map the cleanup sequence without implementing it now.

Freddmannen-only merge rule: this backlog belongs to Fred's fork/version. Do not merge this audit section, or PR it, into `dmarzzz/shape-rotator-os`.

## Policy

Do not begin with a rewrite. The current app is live, release-packaged, and has working build checks. The correct approach is controlled extraction with guardrails.

Recommended rule: every product PR that touches `alchemy.js`, `boot.js`, `styles.css`, or `main.js` must either:

1. Reduce responsibility in that file, or
2. Add a focused guardrail/test for the behavior it changes, or
3. Explicitly justify why it is a temporary exception.

## Phase 0: Stop the bleeding

Priority: immediate.
Confidence: high.

Tasks:

- Add `.claude/` and `tmp/` to `.gitignore`.
- Add a repo hygiene check that fails if untracked runtime cache paths are present in a PR.
- Add an architecture budget script that reports:
  - Files over 1,000 lines.
  - Files over 2,500 lines.
  - Files with more than N direct `innerHTML` assignments.
  - Files with more than N `addEventListener` calls.
  - Files with more than N imports.
- Add the budget report to PR checks in warning mode first.
- Add missing spec-document resolution:
  - Restore `docs/SHAPE-ROTATOR-OS-SPEC.md`, or update all references to the correct current spec.
  - Resolve `docs/SYNC.md` references by linking to the swf-node repo/spec explicitly or vendoring a short local sync-contract note.

Exit criteria:

- New PRs cannot accidentally add runtime cache directories.
- The biggest files are visible in every PR.
- Missing spec references are no longer accepted as normal.

## Phase 1: Make risky modules testable before extracting

Priority: immediate.
Confidence: high.

Tasks:

- Add `check:schema`:
  - Validate every markdown record has required fields.
  - Validate unique `record_id` across each record type.
  - Validate references: person `team`, `secondary_teams`, dependencies `source` and `target`, asks `author` and `claimed_by`, cluster `teams`.
  - Validate controlled `skill_areas`.
  - Validate enum-ish fields documented in `cohort-data/schema.yml`.
- Add unit tests for pure helpers already extracted:
  - `cohort-source` merge behavior.
  - `sync-client` request/response handling.
  - profile slug/YAML generation.
  - context-vault model helpers.
- Promote existing local checks into PR CI:
  - `npm test`
  - `npm run test:models`
  - `npm run check:ics`
  - `npm --workspace @shape-rotator/os run check:packaging`
  - `node apps/os/scripts/check-router-channels.cjs`
- Add a cheap renderer smoke in PR CI if feasible; if not, document why release-only smoke is the accepted risk.

Exit criteria:

- The highest-risk extraction targets have enough tests to move behavior without blind trust.
- PR checks cover the same basic correctness envelope developers run locally.

## Phase 2: Split `alchemy.js` by product mode

Priority: high.
Confidence: high.

Target shape:

```text
apps/os/src/renderer/alchemy/
  index.js              # public mount/setActive/location API
  state.js              # shared state and localStorage keys
  modes.js              # mode definitions and routing
  membrane.js           # existing membrane adapter/data bridge
  constellation/
    index.js
    model.js
    map-view.js
    ring-view.js
    journey-view.js
    stack-view.js
    collab-view.js
    inspector.js
  profile/
    index.js
    fields.js
    markdown.js
    sync-submit.js
    github-submit.js
  asks/
    index.js
    markdown.js
  context/
    index.js
    article-markdown.js
    raw-scripts.js
  program/
    index.js
    markdown.js
  onboarding/
    index.js
  calendar/
    index.js
    export.js
```

Extraction order:

1. Profile editor and markdown generation.
2. Context Vault UI and markdown generation.
3. Asks compose/status behavior.
4. Program markdown rendering.
5. Onboarding.
6. Constellation model helpers.
7. Constellation views.

Why this order:

- Profile/context/asks have clearer boundaries and lower visual coupling than constellation.
- Constellation is large and active; extract its pure model helpers first, then views.

Exit criteria:

- `alchemy.js` becomes an API wrapper or disappears.
- No single alchemy child module exceeds 1,500 lines without explicit budget exception.
- Profile markdown generation has tests.
- Context/ask markdown generation has tests.

## Phase 3: Split `styles.css` by ownership

Priority: high.
Confidence: high.

Target shape:

```text
apps/os/src/styles/
  tokens.css
  reset.css
  shell.css
  tabs.css
  graph.css
  network.css
  alchemy.css
  alchemy-constellation.css
  alchemy-profile.css
  alchemy-context.css
  atlas.css
  easel.css
  router-compat.css
  legacy-compat.css
```

Rules:

- New styles go into the owning stylesheet, not the global end of file.
- `legacy-compat.css` is the only place allowed to contain "wins the cascade" overrides.
- Tokens live in one place. Legacy variable aliases are allowed but documented as compatibility only.
- Per-mode class prefixes stay strict: `alch-*`, `atl-*`, `easel-*`, etc.

Exit criteria:

- `apps/os/src/styles.css` no longer exists as a 19k-line global file, or becomes a small import manifest.
- No visual mode depends on late-file ordering from an unrelated mode.
- Style ownership is obvious during review.

## Phase 4: Turn `boot.js` into a real bootstrapper

Priority: high.
Confidence: high.

Target modules:

```text
apps/os/src/renderer/app/
  boot.js
  update-chip.js
  graph-runtime.js
  events-panel.js
  network-panel/
    index.js
    peers.js
    sync-log.js
    traffic.js
    confidence.js
  swarm-panel.js
  keyboard.js
  legacy-panels.js
```

Rules:

- `boot.js` should create app state, initialize top-level modules, and stop.
- Network panels should not live in the graph bootstrapper.
- Legacy panels should be explicit and removable.
- SSE/polling subscriptions should return cleanup functions.

Exit criteria:

- `boot.js` drops below 1,500 lines.
- Network panel behavior is testable without booting the graph.
- Swarm panel and update chip can be reasoned about independently.

## Phase 5: Split Electron main process by IPC namespace

Priority: medium-high.
Confidence: high.

Target modules:

```text
apps/os/main/
  index.js
  windows.js
  prefs-ipc.js
  context-vault-ipc.js
  updates-ipc.js
  daemon-ipc.js
  swarm-ipc.js
  easel-ipc.js
  export-ipc.js
  shell-ipc.js
```

Rules:

- Each module registers one IPC namespace.
- IPC payload validation lives beside the handler.
- Privileged APIs like shell, file writes, downloads, and clipboard are isolated.
- Context Vault article logic should be shared with build scripts or moved to a common module.

Exit criteria:

- `main.js` is primarily app lifecycle and module registration.
- Context Vault logic is no longer duplicated between `main.js` and `scripts/build-context-vault-corpus.js`.
- IPC channel inventory can be generated.

## Phase 6: Clean up vendoring and generated outputs

Priority: medium.
Confidence: high.

Tasks:

- Add explicit freshness checks for:
  - `apps/os/src/vendor/shape-ui` vs `packages/shape-ui`.
  - `apps/web/shape-ui` vs `packages/shape-ui`.
  - `apps/web/cohort-surface.json` vs `apps/os/src/cohort-surface.json`.
  - generated journal pages vs source articles.
- Add a `docs/generated-artifacts.md` page listing:
  - Source of truth.
  - Generated path.
  - Generation command.
  - Whether generated path is tracked or ignored.
- Decide whether Electron can import workspace package code directly after the renderer bundler cutover.

Exit criteria:

- Generated and vendored copies cannot silently drift.
- Developers know which files are safe to edit.

## Phase 7: Router/daybook stabilization

Priority: medium.
Confidence: moderate-high.

Tasks:

- Keep `check-router-channels.cjs`, but also check push-channel emitters semantically where possible.
- Split `apps/os/src/router/app.js` into:
  - identity/connect
  - interview/voice
  - digest/draft
  - scope manager
  - feed
  - device link
  - shared DOM helpers
- Document the upstream vendoring process and expected diff review.

Exit criteria:

- Router pop-out UI has clear feature modules.
- Vendored adapter drift is caught before runtime.

## Phase 8: Atlas stabilization

Priority: medium.
Confidence: moderate.

Tasks:

- Extract pure topic/clustering functions from `atlas.js`.
- Add tests for:
  - stopword/tokenization behavior.
  - c-TF-IDF label selection.
  - k-means/MDS output shape and determinism.
  - viewport persistence math.
- Keep the canvas render loop in one module only after data prep is extracted.

Exit criteria:

- `atlas.js` remains a renderer, not renderer plus clustering library plus interaction framework.
- Topic labeling and clustering can be changed without visual regression fear.

## Phase 9: Review policy for future PRs

Priority: ongoing.
Confidence: high.

Suggested PR labels or checklist fields:

- `touches-hot-file`: `alchemy.js`, `boot.js`, `styles.css`, `main.js`.
- `adds-mode`: adds a new product mode/surface.
- `adds-ipc`: adds or changes IPC channel.
- `adds-generated`: changes generated or vendored output.
- `schema-impact`: changes `cohort-data/schema.yml` or record fields.
- `visual-risk`: requires screenshot/visual QA.
- `merge-risk`: touches same hot section as another active PR.

Suggested hard rules:

- No new product mode may be implemented directly inside `alchemy.js`.
- No new top-level app feature may be implemented directly inside `boot.js`.
- No new IPC namespace may be registered directly in `main.js`.
- No CSS fix may be appended to the end of global CSS without naming the owned surface it belongs to.
- Any PR touching generated copies must include the generation command in the PR body.

## What not to do

- Do not rewrite the whole app in a new framework.
- Do not split files mechanically by line number.
- Do not move CSS before adding visual checks for the affected mode.
- Do not delete legacy paths until their current product role is known.
- Do not clean up generated/vendor copies by hand without freshness checks.

The priority is to create boundaries that match the product. The codebase can recover without a rewrite if future PRs stop feeding the same four files.
