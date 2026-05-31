# TODO — Electron → Tauri migration of `apps/os`

Migrating `apps/os` from Electron 33 to **Tauri 2** at full parity, plus iOS/Android.
Full plan: `~/.claude/plans/warm-wobbling-catmull.md`. Crate: `apps/os/src-tauri/`.
Renderer is unchanged behind `apps/os/src/api-shim.js` (`window.api` → Tauri `invoke`/`listen`).

## ✅ Done & verified (compiles, `tauri dev` boots, `SROS_SMOKE_TEST=1` exits 0)
- [x] **Phase 1** — scaffold `src-tauri` + `scripts/tauri-prebuild.cjs` → `dist-frontend`; mobile-ready (`#[cfg_attr(mobile,…)]`, mobile Rust targets installed)
- [x] **Phase 2** — `window.api` shim + commands: prefs, env, clipboard, openExternal, open_downloaded_installer, signal_ready
- [x] **Phase 3** — shell: hermes window, native menu (Cmd/Ctrl+Shift+H), window-state, `--smoke-test`
- [x] **Phase 5** — swf-node supervisor (state machine, indrex squatter probe, agent token, restart cap, SIGTERM→SIGKILL, focus recheck)
- [x] **Phase 6** — research-swarm supervisor + `keyring` secrets (replaces `safeStorage`)
- [x] **Phase 8** — calendar export PNG (native dialog + write)

## 🔜 Remaining
- [ ] **Phase 4 — context-vault** (~900-line port; currently a graceful empty-manifest stub): `walkTranscriptFiles`, date/speaker/skill/signal inference regexes, frontmatter parse, raw-bundle + corpus markdown, `hashShort`. Unit-test vs fixtures.
- [ ] **Phase 7 — updater**: `tauri-plugin-updater` (endpoints + EdDSA pubkey) + custom `download_and_reveal_update`; generate signing keypair.
- [ ] **Phase 9 — easel/NDI**: Node sidecar re-hosting `easel-ndi.js` + `ws`; renderer connects `ws://127.0.0.1:<port>` (binary protocol already in `api-shim.js`); `getDisplayMedia` replaces `desktopCapturer`; send pump in a Worker.
- [ ] **Phase 10 — CI/packaging**: `tauri.conf` bundle/externalBin/entitlements/Info.plist; per-triple `fetch-*.sh`; `build-ndi-sidecar.cjs`; rewrite `os-release.yml` (per-(OS,arch) matrix + `tauri-action` + `latest.json`); drop electron-builder.

### Renderer follow-ups
- [ ] Vendor **jsPDF** + `window.__srfgMakePdfDataUrl` for calendar **PDF** (Rust already writes any data URL).
- [ ] `easel.js`: `getDisplayMedia()` + Worker send pump (no `setBackgroundThrottling` in Tauri).

### Mobile (iOS/Android) — code ready; setup in `apps/os/TAURI-MOBILE.md`
- [ ] `tauri:ios:init` (needs full Xcode + CocoaPods) · `tauri:android:init` (needs JDK 17 + Android SDK/NDK)
- [ ] Responsive layout pass; "remote swf-node URL" settings (no local daemon on mobile)

### Improvements ("do better")
- [ ] Type-safe IPC via `tauri-specta`; flesh out E2E (`apps/os/e2e/`, `webdriver` feature wired)
- [ ] Audit `ExitRequested` vs macOS window-close; add `tauri-plugin-single-instance` (avoid `:7777` races)
- [ ] `tracing` logging + panic/crash file; release profile (LTO/strip/opt-z); measure bundle-size win vs Electron

---

# TODO — Matrix client (the "matrix" tab)

Work-in-progress tracker for the embedded Matrix client. Full design:
[`specs/matrix.md`](specs/matrix.md) · parity checklist: [`specs/matrix-parity.md`](specs/matrix-parity.md).

Reference clones (read-only, gitignored): `reference/element-web`, `reference/matrix-rust-sdk` (v0.17),
research briefs: `reference/_research-briefs.md`.

## ✅ Done (committed to main, all tests green)
- [x] Research (4-agent parallel workflow: SDK core, crypto/media, Element inventory, Tauri bridge)
- [x] Spec v1.0 + ~190-item Element parity checklist
- [x] Tauri-migration baseline committed (foundation the Matrix work builds on)
- [x] `matrix-sdk` 0.17 + `matrix-sdk-ui` deps — `cargo build` green
- [x] Rust diff bridge core `src-tauri/src/matrix/diff.rs` (VectorDiff→JSON envelope) — 10 unit tests
- [x] JS diff applier `src/renderer/matrix/diff.js` (`applyDiffs` + `SeqGuard`) — 13 `node --test` cases

## 🔜 Remaining — Phase C (auth + sync)
- [ ] `src-tauri/src/matrix/state.rs` — `MatrixState { inner: Arc<Mutex<MatrixInner>> }` (client,
      room_list, sync_task, room_list_task, open_rooms); add `matrix` field to `AppState` (all-platform)
- [ ] `src-tauri/src/matrix/session.rs` — SQLite store dir under `paths::user_data`; store passphrase +
      access/refresh tokens in keyring (`secrets.rs`, desktop) with dev-file fallback; `MatrixSession`
      metadata JSON via `json_store`
- [ ] `src-tauri/src/commands/matrix.rs` — `matrix_login_password`, `matrix_sso_url`/`_complete`,
      `matrix_restore`, `matrix_logout`, `matrix_whoami`, `matrix_sync_start`/`_stop`; emit
      `matrix://session` + `matrix://sync-state`. Use `SyncService` (supervise `.state()`, re-`start()`
      on Error/Offline) + `EncryptionSettings { auto_enable_cross_signing, auto_enable_backups }`
- [ ] Register matrix commands in `lib.rs` `invoke_handler![]`; abort tasks + drop client on
      `RunEvent::ExitRequested`
- [ ] Renderer: `src/api-shim.js` → add `window.api.matrix` (invoke + `sub()` event channels)
- [ ] Renderer: visible **matrix tab** — `index.html` tab button + `<section id="matrix-view"
      class="matrix-only">`; new `src/renderer/matrix/matrix.css` for `.matrix-only` visibility;
      `boot.js` add `"matrix"` to `TOP_TABS` + `applyActiveTab` branch *(isolate this boot.js edit via
      `git stash` so it doesn't sweep up unrelated in-flight edits)*
- [ ] Renderer: `src/renderer/matrix/index.js` (mount/unmount, event wiring) + `auth.js` (login form →
      synced empty state)

## 🔜 Phase D — room list
- [ ] `matrix/diff_dto.rs` — `RoomDto` (id, name, avatar mxc, isDirect, unread/highlight counts,
      lastEventTs, preview) — panic-free projection
- [ ] `matrix/pump.rs` — generic `spawn_diff_pump<T,V,S>` (seed Reset from snapshot → drain stream →
      `app.emit` batches) + `AbortHandle`
- [ ] `matrix/rooms.rs` — `RoomListService.entries_with_dynamic_adapters` → pump →
      `matrix://room-list-diff`; `matrix_room_list_subscribe` / `matrix_room_list_set_filter`
- [ ] Renderer `roomlist.js` — apply diffs, render tiles (avatar/name/preview/unread), filters

## 🔜 Phase E — timeline (read)
- [ ] `matrix/timeline.rs` + `TimelineItemDto` (kind event|dateDivider|readMarker; sender, body,
      formatted, msgtype, mxc, reactions, sendState, isEdited, unique_id key)
- [ ] `matrix_room_open`/`matrix_room_close` (per-room timeline pump → `matrix://timeline-diff`),
      `matrix_timeline_paginate_back`
- [ ] `matrix_media_url` + Tauri custom protocol (`matrixmedia://`) backed by `client.media()`
- [ ] Renderer `timeline.js` — events, day dividers, read markers, back-pagination, jump-to-bottom,
      lightbox; media bodies (image/video/file/audio)

## 🔜 Phase F — send + interact
- [ ] `matrix_send_message` (markdown), `matrix_send_reply`, `matrix_edit_message`, `matrix_redact`,
      `matrix_react`/`matrix_unreact`, `matrix_set_typing`, `matrix_mark_read`, `matrix_send_attachment`
- [ ] Renderer `composer.js` — markdown composer, reply preview, edit mode, file/image upload+paste,
      reactions UI, message context menu, local-echo states

## 🔜 Phase G — encryption
- [ ] E2EE indicators, room encryption toggle, UTD tiles
- [ ] Device verification (SAS emoji + QR): `matrix_verification_*` + `matrix://verification` event
- [ ] Cross-signing bootstrap, key backup + recovery (4S), reset identity; trust shields

## 🔜 Phases H–K (see specs/matrix-parity.md, mapped per item)
- [ ] H — rooms & spaces (create/join/leave, invite, power levels, room settings, spaces panel)
- [ ] I — composer+ & extras (emoji picker, mentions, slash commands, voice, polls, location, search)
- [ ] J — calls (Element Call group + 1:1 voip, screen share, PiP)
- [ ] K — settings & parity sweep (settings surfaces, themes, devices/sessions, reconcile checklist)

## Conventions / invariants
- Atomic emoji conventional commits; keep `apps/os` bootable each commit
  (`SROS_SMOKE_TEST=1` boot must exit 0)
- Keep Element-specific UI isolated in `src/renderer/matrix/` + `matrix.css`, and SDK glue in
  `src-tauri/src/matrix/`, so later customization is localized (parity item 12 "Customisations")
- Matrix runtime is **all-platform** (not `#[cfg(desktop)]`); only keyring is desktop-only
- Tests: `cargo test --lib matrix::` · `node --test apps/os/src/renderer/matrix/*.test.mjs`
- Mutex rule: lock → clone out `Arc<Client>`/`Arc<Timeline>` → drop guard → async work (never hold
  the guard across a long `.await`)
- Don't sweep up other agents' uncommitted edits when committing matrix work

---

# TODO — Agent tab (local Codex / Claude Code)

Design doc: [`specs/agent.md`](specs/agent.md) (v0.1, **design only — not scheduled**).
Draft is written; a 5-persona simulated-user panel (maintainer, terminal-native founder,
non-technical operator, security/governance, product skeptic) returned **zero approvals**.
Architecture is sound; the embedded terminal + several safety claims need rework before build.

## Product decision to settle first
- [ ] **Invert the deliverable?** Panel's highest-leverage call: make the **MCP server
      (Phases C–E) the v0.1 product** — standalone `127.0.0.1` loopback with a printable
      connection snippet users paste into their own `claude`/`codex` config — and defer the
      embedded PTY+xterm tab (Phases A/B/F) to v0.2 behind an explicit "why embed"
      justification. (Real product call for Daniel, not a mechanical edit.)

## Blockers (before build)
- [ ] §0 **Jobs-to-be-done** (who can help with X / who's working on Y / draft-refresh
      profile); trace every section to one. Rewrite §7 testing as *outcome* acceptance
      ("member types a need → ≥1 correct citable person in <10s"), not "the TUI renders."
- [ ] §5: reads return **public surface bundle ONLY** via an explicit field allow-list;
      `cohort_get_record`/`sync_get_record` must refuse depth-tier fields (`profile_lens`,
      `facilitator.*`, `growth_edge`, `salient_tensions`, `open_questions`). Add a test proving
      no depth field ever appears — including for a key-holding alchemist.
- [ ] §6 **Data egress** subsection: read results leave the machine to the user's cloud model
      provider (the one non-local part of a local-first product). One-time consent on first use.
- [ ] Reconcile §1 "inherits the user's auth" vs §3.2 `env_clear()`: default user-facing path to
      inheriting real HOME/PATH + config; reserve clean-env for E2E tests. Phase B test: auth
      survives the spawn.

## Should-fix
- [ ] §6 honesty note: agent is unsandboxed → MCP write-gate + "bearer never returned" are UX
      guardrails, not a boundary (agent can read `userData/swf-node-data/agent_token` + hit
      `:7777`). Move token out of agent-readable scope or document it.
- [ ] §6 **prompt-injection**: treat self-authored cohort free-text as untrusted; wrap reads as
      data-not-instructions; write dialogs show full payload + provenance.
- [ ] §5/§6: specify the **confirmation surface** — plain-language summary + readable diff/preview
      (full PR diff, full sync envelope, target repo/branch/handle), how `mcp.rs` binds a write to
      the active session, no "remember my choice" for writes, looping/rate-limit guard.
- [ ] Fix §3.2: NOT a reuse of `resolve_agent_binary` (that resolves `research-agent` via
      `RESEARCH_AGENT_BIN`). Rename to "a new resolver modeled on swarm's"; enumerate `claude`/
      `codex` probe locations (npm/bun global, `~/.local/bin`, Homebrew, asdf/volta, npx, aliases).
- [ ] Rebuild §8 risk register: demote stdio-vs-loopback / cwd / persistence; promote
      clean-env-vs-auth, write-to-session binding, CLI flag drift
      (`--mcp-config`/`--strict-mcp-config`), data egress. Resolve transport → loopback.
- [ ] Resolve `open_pr_draft` overlap with the existing `shape-rotator-profile` skill — defer the
      profile job to the skill or justify the tab as a better surface; `sync_push` is the only
      net-new write.
- [ ] Change default cwd (Open Q5) to repo/configurable project dir, not empty scratch; note the
      scratch dir shares a parent with `cohort-keys.json` + the token.
- [ ] Define empty/error state when no binary detected (guided onboarding, not a blank terminal);
      scope audience honestly (v0.1 = technical members).

## Nice-to-have
- [ ] Fix stale `boot.js` anchors (APPS_VIEWS ~5968 not ~1479; `applyActiveTab` ~6299); re-verify
      integration points against current `boot.js`.
- [ ] One sentence justifying the `xterm.js` + `addon-fit` + `portable-pty` dependency add vs the
      vanilla-JS line-stream baseline.
- [ ] Reinstate "Alternatives considered" (structured-chat UI + its cost to non-technical members).
- [ ] If the embedded tab survives v0.1: terminal-parity bar (TERM/truecolor, mouse, scrollback,
      copy-paste, keybinding passthrough) + multi-session/persistence milestone.
