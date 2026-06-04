# Vendored from `router-daybook` — do not edit these files

Every `*.js` in this directory is copied **byte-for-byte** from the upstream
`router-daybook` repo, and so is the pop-out window's renderer + preload under
`../src/router/`. Keeping them verbatim is what makes upstream updates a clean
re-copy instead of a manual merge — so **do not hand-edit them**. All
host-specific adaptation lives OUTSIDE the vendored files:

- **IPC host adapter** — `../daybook-main.js` replaces upstream `src/main.js`. It
  registers the SAME un-namespaced channels (`bootstrap`, `draft:build`,
  `refine:*`, `feed:get`, `streak:get`, `post`, `link-*`, …) by delegating to the
  vendored pipeline here, and owns the pop-out window. It deliberately does NOT
  port: the dock/tray icon, the MLX-Whisper sidecar, or the daily precompute
  daemon (background SSH/HTTP egress with the window closed).
- **Subprocess PATH** — `ensureClaudeOnPath()` in `daybook-main.js` augments the
  process PATH once so the vendored `reflect.js`/`intro.js`/`draft.js` find the
  `claude` CLI in a packaged build, without editing them.
- **Voice** — WIRED, cross-platform, on-device. `transcribe-audio` in
  `daybook-main.js` does ffmpeg → 16kHz wav → a Whisper engine, picked by
  platform (`ROUTER_WHISPER=mlx|cpp` overrides):
    - **Apple Silicon →** the resident **MLX-Whisper** sidecar
      (`daybook/whisper_server.py`, vendored; needs `uv` + `mlx-whisper`). Fast.
    - **Windows / Linux / Intel mac →** **whisper.cpp** via `../daybook-whisper.js`
      (HOST-OWNED, not vendored — survives the sync). Ships a per-platform
      `whisper-cli` + `ggml-base.en.bin` + bundled `ffmpeg` under
      `Contents/Resources/whisper/`. CI (`.github/workflows/os-release.yml`)
      stages them per-arch via repo-root `scripts/fetch-whisper.sh` →
      `build-resources/_staging/whisper/<arch>/`, which the `beforePack` hook
      (`before-pack-stage-binaries.cjs`, BUNDLES includes `whisper`) flattens
      into `build-resources/whisper/` → extraResources. Like swf-node it
      **degrades gracefully**: a target with no staged binary falls back to MLX
      (Apple Silicon) or type-only, and the build still succeeds. In dev it falls
      back to a Homebrew/PATH `whisper-cli`/`ffmpeg` + the model in
      `build-resources/whisper/`.
  The router window's session grants `'media'` (scoped to that window only) for
  the mic. Audio is on-device — only the transcribed TEXT returns (then through
  the normal redaction chain). If no engine is available on a machine,
  `transcribe-audio` returns `''` and the interview falls back to typing.
  Per-platform `whisper-cli` binaries are staged by each OS's CI runner (the
  model + the macOS binary by the fetch script); the large artifacts are
  gitignored.
- **Data location** — UNCHANGED from upstream: state in `~/.router-daybook/`
  (`scope.json`, `redactions.json`, `notes.jsonl`, `patterns.json`, `drafts/`,
  `peers.json`, `introduced`) and identity in `~/.routerrc`. In `$HOME`, writable
  in a packaged build, and **shared** with a standalone `router-daybook` install
  if the user runs one. Nothing is re-rooted. (Interview `.md` archives use the
  repo-relative `interviews/` dir, which is read-only in a packaged build —
  best-effort, silently skipped there; the interview content still flows to
  generation.)

## Device-link + privacy notes

`draft.js` hard-requires `./link`, so `link.js` is vendored and the `link-*`
handlers are wired. This re-introduces device-link: **plaintext-TCP pairing**
(shared secret in the pairing code), **SSH** peer reads (TOFU host keys), and
saved peers in `~/.router-daybook/peers.json` that `link.collectPeerToday` folds
into **every** `buildDraft` — i.e. opening the window does a background SSH read
of each saved peer + an HTTP feed fetch. `startHost` is opt-in from the Link UI.

The privacy invariants are intact: `redact.js` is the single redactor; the
`post` handler re-scrubs the exact outgoing bytes via the SAME
`scopeMod.loadRules()` the generate() scrubs use (all modules read one
`redactions.json`); `redaction:reveal` is local-only. NOTE the on-disk draft
cache (`~/.router-daybook/drafts/*.json`, `latest.json`) holds the scrubbed (but
best-effort) digest + post at rest.

## Source

- Repo: https://github.com/jameslbarnes/router-daybook
- Vendored at commit: `c8fb9ff` (working tree) — re-run the sync script to update.

## What is vendored

Pipeline (`apps/os/daybook/`): `redact.js`, `scope.js`, `preferences.js`,
`transcripts.js`, `router.js`, `reflect.js`, `postspec.js`, `intro.js`,
`draft.js`, `link.js` — plus any new module they come to require (the sync copies
by denylist).

Renderer + shim (`apps/os/src/router/`): `app.js`, `index.html`, `styles.css`
(the source renderer, run VERBATIM in the pop-out window) and `preload.js` (the
source `src/preload.js`, the `window.daybook` shim).

Also vendored: `src/whisper_server.py` → `daybook/whisper_server.py` (the voice
sidecar; ships via the `daybook/**/*` build glob).

NOT vendored: `src/main.js` (→ `daybook-main.js`).

## Re-syncing upstream

```sh
apps/os/scripts/sync-daybook-vendor.sh ~/router-daybook
```

Copies the pipeline `*.js` (denylist: `main.js`, `preload.js`) into
`apps/os/daybook/`, the renderer + `src/preload.js` into `apps/os/src/router/`,
then runs a require-graph load test (catches a new unvendored dependency
immediately — the way `reflect.js → ./postspec` or `draft.js → ./link` would
otherwise break the build). After a clean sync: review `git diff`, bump the
commit pin above, then `(cd apps/os && npm run bundle:check && npm run smoke)`.
When the source adds a NEW un-namespaced IPC channel (a new `window.daybook.*`
method), add a matching `ipcMain.handle` in `daybook-main.js` — that hand-port is
the one piece the file-copy can't do.
