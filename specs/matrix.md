# Spec: Matrix client ("matrix" tab) in Shape Rotator OS

Status: **v1.0** — architecture + API finalized from research (4-agent `matrix-research` workflow:
SDK core, crypto/media, Element inventory, Tauri bridge). Integration points verified against the
current codebase. Full parity checklist: **`specs/matrix-parity.md`** (~190 items).

> Goal: a Matrix chat client embedded as a new top-level **matrix** tab in `apps/os`, powered by the
> **matrix-rust-sdk** (Rust) over the existing Tauri 2 backend. Target **100% feature parity with
> Element Web**, structured so the UI/behaviour is easy to customize later. Reference sources are
> cloned read-only under `reference/` (gitignored).

---

## 1. Why this shape

We already migrated `apps/os` from Electron → Tauri 2 (see `~/.claude/memory/tauri-migration.md`). The
renderer is plain vanilla JS talking to a Rust backend via `window.__TAURI__.core.invoke` + `event.listen`,
bridged by `apps/os/src/api-shim.js`. Because we're on Tauri (Rust), we use the **matrix-rust-sdk**
directly in the backend instead of `matrix-js-sdk` in the webview. This is the same engine that powers
Element X (iOS/Android) — it gives us encryption, sync, room list, and timeline as a maintained Rust
library, and keeps secrets/crypto out of the webview.

The renderer stays a thin view: it holds local arrays that it keeps in sync by applying **diffs** the
backend streams over Tauri events. This mirrors how Element X consumes the SDK's reactive
`eyeball::Vector<VectorDiff>` streams across its FFI boundary — our `invoke`/`event` boundary is
analogous.

### Reference data (read-only, gitignored under `reference/`)
- `reference/element-web` — Element Web monorepo. App source: **`apps/web/src`** (661 `.tsx` files).
  Parity map lives in `apps/web/src/components/views/{auth,messages,rooms,room_settings,spaces,
  settings,verification,voip,polls,location,emojipicker,right_panel,directory,avatars,...}`.
- `reference/matrix-rust-sdk` — the SDK. Key crates: `matrix-sdk`, **`matrix-sdk-ui`** (the high-level
  `room_list_service`, `timeline`, `sync_service`, `spaces`, `notification_client`), `matrix-sdk-base`,
  `matrix-sdk-crypto`, `matrix-sdk-sqlite`, `matrix-sdk-qrcode`. Current version: **0.17.0**.

> ⚠️ Toolchain note: the SDK git HEAD declares `rust-version = 1.93`. Our crate pins `1.77`. We pin the
> **published crates.io 0.17.x** (lower MSRV) rather than the git HEAD, and bump our `rust-version` if
> the resolved MSRV requires it. Resolve during Phase B (deps spike) before committing to the version.

---

## 2. Architecture overview

```
┌───────────────────────────── webview (renderer, vanilla JS) ──────────────────────────────┐
│  matrix tab  ─►  src/renderer/matrix/*.js                                                   │
│     • holds local arrays: rooms[], timeline[] (per open room)                              │
│     • applies VectorDiff envelopes from backend events → re-renders                         │
│     • calls window.api.matrix.* for actions (login, send, react, paginate, verify…)        │
└───────────────▲───────────────────────────────────────────────┬───────────────────────────┘
   event.listen │ matrix://room-list-diff, matrix://timeline-diff │ invoke(matrix_*)
   (diff stream)│ matrix://sync-state, matrix://verification, …   │ (commands)
┌───────────────┴───────────────────────────────────────────────▼───────────────────────────┐
│  Tauri backend (Rust)  ─►  src-tauri/src/commands/matrix.rs  +  src-tauri/src/matrix/*.rs   │
│     • AppState.matrix : Arc<Mutex<MatrixRuntime>>  (Client + SyncService + handles)         │
│     • diff-bridge tasks: tokio tasks consuming Vector<VectorDiff> → app.emit(envelope)       │
│     • SQLite store in app-data dir; session JSON in prefs, tokens in keyring                 │
│           matrix-sdk  +  matrix-sdk-ui  +  matrix-sdk-sqlite                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Key idea: the diff bridge
The SDK exposes rooms and per-room timelines as reactive `eyeball::Vector<T>` streams that yield
`VectorDiff<T>` updates. We serialize each diff into a small JSON envelope and emit it to the renderer,
which applies it to a local mirror array. This gives O(diff) UI updates and avoids re-fetching state.

```jsonc
// matrix://timeline-diff payload (one of these per VectorDiff)
{ "roomId": "!abc:hs", "ops": [
  { "op": "reset",  "values": [ /* TimelineItemDto[] */ ] },     // initial / gappy
  { "op": "append", "values": [ /* … */ ] },
  { "op": "pushBack",  "value": { /* … */ } },
  { "op": "pushFront", "value": { /* … */ } },
  { "op": "insert", "index": 3, "value": { /* … */ } },
  { "op": "set",    "index": 3, "value": { /* … */ } },
  { "op": "remove", "index": 3 },
  { "op": "truncate", "length": 50 },
  { "op": "clear" }
]}
```

The renderer applies these with a tiny pure reducer (`applyDiff(arr, op) -> arr`), unit-tested in
isolation. `VectorDiff` variants map 1:1 to the ops above (`Append, Clear, PushFront, PushBack,
PopFront, PopBack, Insert, Set, Remove, Truncate, Reset`).

---

## 3. Backend design (Rust)

### 3.1 Crates (finalized — **matrix-sdk 0.17.0**)
All matrix-sdk-* crates are version-locked and must match (0.17). Verified against the clone +
crates.io. `eyeball-im` (the reactive Vector/VectorDiff type) is **re-exported** as
`matrix_sdk_ui::eyeball_im` — import it from there, never as a direct dep, to avoid a type-skew where
our `VectorDiff` differs from the SDK's.
```toml
matrix-sdk    = { version = "0.17", default-features = false, features = [
    "e2e-encryption",                 # crypto state machine (most rooms are encrypted)
    "sqlite", "bundled-sqlite",       # state + crypto + event-cache store; bundle libsqlite3 (no system dep)
    "automatic-room-key-forwarding",  # auto key-forward between your own verified devices
    "rustls-tls",                     # matches our existing reqwest rustls; avoids OpenSSL cross-compile
    "markdown",                       # RoomMessageEventContent::text_markdown(...)
    "sso-login",                      # matrix_auth().login_sso(...)
    "qrcode",                         # QR device verification
] }
matrix-sdk-ui = { version = "0.17", default-features = false, features = ["e2e-encryption"] }
futures-util  = "0.3"                 # StreamExt for diff streams (already present)
mime          = "0.3"                 # attachment uploads
```
`bundled-sqlite` is the key cross-platform choice (static SQLite → clean macOS/Windows/Linux/iOS
bundles). We already depend on `tokio` multi-thread, `reqwest` rustls, `serde`/`serde_json`,
`keyring`, `dirs`/`tauri` app-data paths — reused here. **MSRV:** SDK HEAD wants 1.93; local toolchain
is 1.94.1 — bump the crate's `rust-version` to `1.93` (or whatever `cargo` resolves) when adding deps,
and confirm CI uses ≥ that.

**Make E2EE "just work"** via the builder:
```rust
.with_encryption_settings(EncryptionSettings {
    auto_enable_cross_signing: true,
    auto_enable_backups: true,
    backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
})
```
After login/restore, `client.encryption().wait_for_e2ee_initialization_tasks().await` before reading
cross-signing/backup state (they init asynchronously).

Prior art to crib from: **`IT-ess/tauri-plugin-matrix-svelte`** (Tauri + matrix-rust-sdk + keyring
session storage) and the SDK's own `examples/{persist_session,oauth_cli,timeline,emoji_verification,
cross_signing_bootstrap}`.

### 3.2 State (`src-tauri/src/state.rs`)
Add `matrix: Arc<tokio::Mutex<MatrixRuntime>>` to `AppState`. `MatrixRuntime` holds:
- `client: Option<matrix_sdk::Client>`
- `sync_service: Option<Arc<matrix_sdk_ui::sync_service::SyncService>>`
- `room_list: Option<...>` + the room-list diff task `AbortHandle`
- `timelines: HashMap<OwnedRoomId, OpenTimeline>` where `OpenTimeline` keeps the `Timeline` + its
  diff-task `AbortHandle` (so opening/closing a room starts/stops exactly one stream task)
- `app: AppHandle` for emitting events

Available on all targets (Matrix works on mobile too) — **not** behind `#[cfg(desktop)]`, unlike the
subprocess supervisors. Keyring secret storage is desktop-only; on mobile fall back to the encrypted
SQLite store passphrase / prefs.

### 3.3 New modules
- `src-tauri/src/commands/matrix.rs` — the `#[tauri::command]` surface (§4).
- `src-tauri/src/matrix/mod.rs` — runtime struct, client build, store paths.
- `src-tauri/src/matrix/diff.rs` — `VectorDiff<T> → envelope` serialization (+ `TimelineItemDto`,
  `RoomDto` mapping). **Pure, unit-tested.**
- `src-tauri/src/matrix/bridge.rs` — the tokio tasks that consume streams and `app.emit`.

### 3.4 Session & store persistence
- Store: `sqlite_store(<app-data>/matrix/<user_id_hash>, Some(passphrase))`.
- Session: persist `client.matrix_auth().session()` (a `MatrixSession`) as JSON via `prefs` store;
  the access/refresh tokens go through the existing **keyring** `secrets` module (desktop). Restore on
  boot with `client.restore_session(session)` before starting the sync service.

---

## 4. Command surface (api-shim → invoke)

Exposed on `window.api.matrix.*`. All return Promises; diff/async updates arrive as events.

| `window.api.matrix.*` | tauri command | purpose |
|---|---|---|
| `loginPassword({homeserver,user,password})` | `matrix_login_password` | password login + persist session |
| `loginSsoUrl({homeserver})` / `completeSso(...)` | `matrix_sso_url` / `matrix_sso_complete` | SSO/OAuth login |
| `restore()` | `matrix_restore` | restore persisted session, returns `{loggedIn,userId}` |
| `logout()` | `matrix_logout` | log out + wipe store/session |
| `whoami()` | `matrix_whoami` | `{userId,deviceId,displayName,avatar}` |
| `syncStart()` / `syncStop()` | `matrix_sync_start` / `matrix_sync_stop` | start/stop SyncService; emits `matrix://sync-state` |
| `roomListSubscribe()` | `matrix_room_list_subscribe` | start room-list diff stream → `matrix://room-list-diff` |
| `setRoomListFilter(f)` | `matrix_room_list_filter` | all / favourites / unread / people / search text |
| `openRoom(roomId)` | `matrix_room_open` | build + subscribe timeline → `matrix://timeline-diff` |
| `closeRoom(roomId)` | `matrix_room_close` | drop timeline + abort its task |
| `paginateBack(roomId,count)` | `matrix_timeline_paginate_back` | back-pagination; returns `{reachedStart}` |
| `sendMessage(roomId,body,{format})` | `matrix_send_message` | send text/markdown |
| `sendReply(roomId,eventId,body)` | `matrix_send_reply` | reply |
| `editMessage(roomId,eventId,body)` | `matrix_edit_message` | edit |
| `redact(roomId,eventId,reason?)` | `matrix_redact` | delete |
| `react(roomId,eventId,key)` / `unreact(...)` | `matrix_react` / `matrix_unreact` | reactions |
| `setTyping(roomId,typing)` | `matrix_set_typing` | typing notifications |
| `markRead(roomId,eventId?)` | `matrix_mark_read` | read receipts / read marker |
| `sendAttachment(roomId,{path|bytes,mime,name})` | `matrix_send_attachment` | files/images/voice |
| `mediaUrl(mxc,{thumb})` | `matrix_media_url` | resolve MXC → renderable URL (custom protocol / temp) |
| `createRoom(opts)` / `joinRoom(idOrAlias)` / `leaveRoom(id)` | `matrix_*` | room lifecycle |
| `invite(roomId,userId)` / `kick/ban/...` | `matrix_*` | membership |
| `roomSettings*` (name/topic/avatar/power levels) | `matrix_*` | room admin |
| `verification*` (request/start SAS/confirm emoji/cancel) | `matrix_*` | device verification → `matrix://verification` |
| `keyBackup*` / `recovery*` | `matrix_*` | key backup + 4S recovery |
| `searchMessages(roomId?,term)` | `matrix_search` | message search |

Events: `matrix://sync-state`, `matrix://room-list-diff`, `matrix://timeline-diff`,
`matrix://room-info` (name/avatar/membership/typing/receipts changes), `matrix://verification`,
`matrix://notification`, `matrix://error`.

---

## 5. Renderer integration points (verified against current code)

Adding a top-level tab is a known pattern here (`alchemy`, `apps`, `network`, `links`):

1. **Tab button** — `apps/os/src/index.html` `#tab-bar` (~line 31): add
   `<button class="tab-btn" role="tab" data-tab="matrix" …>` with a glyph (e.g. `⬡`) + label "matrix".
2. **Panel** — add `<section id="matrix-view" class="matrix-view matrix-only" …>` alongside
   `#alchemy-view` / `#network-view` (index.html ~line 448+). Visibility is driven by
   `body[data-active-tab="matrix"]` + a `.matrix-only` CSS rule (mirror `.net-only` / `.alchemy-only`).
3. **TOP_TABS** — `apps/os/src/renderer/boot.js:5965`: add `"matrix"` to the `TOP_TABS` Set. Tab
   click + `applyActiveTab` already handle the rest; add a `matrix` branch in `applyActiveTab`
   (boot.js ~6299) to mount/teardown the module (start/stop sync polling when (de)activated, like
   the metrics sub-tab does).
4. **Keyboard shortcut** — optional: bind a letter in the keydown handler (boot.js ~6272). `m` is
   taken (metrics); consider `x` or `g`.
5. **api-shim** — `apps/os/src/api-shim.js`: add the `matrix: { … }` object (invoke + `sub()` for the
   event channels), mirroring the existing `easel`/`swarm` blocks.
6. **Module** — new `apps/os/src/renderer/matrix/` (loaded via the importmap that
   `scripts/tauri-prebuild.cjs` rewrites). Submodules: `diff.js` (pure reducer), `store.js` (rooms +
   open timelines), `roomlist.js`, `timeline.js`, `composer.js`, `auth.js`, `verification.js`,
   `settings.js`, `index.js` (mount/unmount, event wiring).
7. **CSP** — `tauri.conf.json` `connect-src` must allow the homeserver(s). Network calls happen in
   Rust (not the webview), so the main concern is `img-src`/`media-src` for resolved MXC media — plan
   to serve media via a Tauri custom protocol (`media-src 'self' matrixmedia:`) to avoid loosening CSP
   to arbitrary homeservers.

The renderer never re-renders the whole list: it applies diffs to `store.rooms` / `store.timelines[roomId]`
and patches the DOM. Keep the design's "easy to customize" goal by isolating all Element-specific
look/behaviour in the `matrix/` modules + a dedicated CSS file.

---

## 6. Feature-parity checklist (master)

The full ~190-item checklist lives in **`specs/matrix-parity.md`** (12 domains: auth, room list,
spaces, timeline, composer, encryption, room settings, calls, user settings, notifications, search,
misc/platform — each item tagged S/M/L and mapped to a phase). Tick items there as they ship. Summary
of the 12 domains:

1. Auth & account lifecycle · 2. Room list / left panel · 3. Spaces · 4. Timeline / room view ·
5. Composer · 6. Encryption (E2EE) · 7. Room settings & management · 8. Voice/video calls ·
9. User settings · 10. Notifications · 11. Search · 12. Misc / platform.

The **customization seam** is domain 12's "Customisations / branding" — re-skinning Element's look
should be a localized change in `src/renderer/matrix/` + `matrix.css`, never a fork of behaviour.

---

## 7. Phased, test-driven plan

Each phase ends with an atomic emoji conventional commit and (where feasible) tests written first.
Phases are ordered so the app stays bootable throughout (other agents may be working in parallel).

- **Phase A — Spec + scaffold** *(this doc)*. `📝 docs(matrix): spec for Matrix client + parity plan`.
- **Phase B — Deps spike**: add `matrix-sdk`/`matrix-sdk-ui` to Cargo, resolve MSRV/feature/TLS,
  `cargo build`. Bare `matrix/mod.rs` + `MatrixRuntime` skeleton + empty `commands/matrix.rs` wired
  into `lib.rs`. Tab + panel + `.matrix-only` CSS + api-shim stub showing an empty "matrix" view.
  Tests: diff reducer (`diff.rs` Rust unit tests; `diff.js` JS tests) written first.
- **Phase C — Auth + sync**: password login, session persist/restore, SyncService start, `sync-state`
  event. Renderer `auth.js` login form → empty synced state.
- **Phase D — Room list**: room-list diff bridge + `roomlist.js` applying diffs; metadata (name,
  avatar, unread, latest event); filters.
- **Phase E — Timeline read**: open room, timeline diff bridge, render events + day dividers +
  back-pagination + read markers; media via custom protocol.
- **Phase F — Send + interact**: composer (markdown), send/edit/redact/react/reply, typing, read
  receipts, attachments.
- **Phase G — Encryption**: E2EE indicators, device verification (SAS), cross-signing, key backup +
  recovery, UTD handling.
- **Phase H — Rooms & spaces**: create/join/leave, invite/membership/power levels, room settings,
  spaces panel + hierarchy.
- **Phase I — Composer+ & extras**: emoji picker, mentions, slash commands, stickers, voice, polls,
  location, pinning, threads, search.
- **Phase J — Calls**: Element Call (group) + 1:1 voip (largest; webview-side).
- **Phase K — Settings & parity sweep**: settings surfaces, themes, devices/sessions mgmt; reconcile
  remaining checklist items; parity review.

### Testing strategy
- **Rust**: `cargo test` unit tests for `diff.rs` (every `VectorDiff` variant → envelope) and
  pure mappers (`TimelineItemDto`, `RoomDto`). Integration against a throwaway homeserver
  (`matrix-sdk`'s test infra / a local Synapse or the `matrix-sdk` mock server) where practical.
- **JS**: unit-test the pure `diff.js` reducer (apply each op to an array). The existing `e2e/`
  (WebdriverIO via the `webdriver` Tauri feature) can later drive the matrix tab against a test HS.
- **Smoke**: `SROS_SMOKE_TEST=1` boot must still exit 0 after each phase (renderer must not throw).

---

## 8. Conventions
- Atomic **emoji conventional commits** as we go (e.g. `✨ feat(matrix): …`, `🐛 fix(matrix): …`,
  `🧪 test(matrix): …`, `📝 docs(matrix): …`). Keep `apps/os` bootable at every commit.
- Keep everything Element-specific isolated in `src/renderer/matrix/` + `matrix.css` and
  `src-tauri/src/matrix/` so later customization is a localized change.
- Reference clones are **read-only** and gitignored — never vendored/committed.

---

## 9. Resolved decisions (from research)
1. **Version/features:** `matrix-sdk`/`matrix-sdk-ui` **0.17.0**, features in §3.1; bump crate
   `rust-version` to the SDK MSRV (~1.93; local is 1.94.1). `eyeball-im` via `matrix_sdk_ui::eyeball_im`.
2. **Sync:** use **`matrix_sdk_ui::sync_service::SyncService`** (drives simplified sliding sync +
   encryption sync as one supervised unit — the Element X pattern). Never touch `SlidingSync` directly.
   `SyncService::room_list_service()` gives the `RoomListService`; supervise `.state()` and re-`start()`
   on `Error`/`Offline`. No manual sync-token persistence (that's only for legacy `sync_once`).
3. **Media:** serve resolved MXC content to the webview via a **Tauri custom protocol**
   (`matrixmedia://<mxc>?thumb=...`) backed by `client.media().get_media_content(...)`, so we don't
   loosen CSP to arbitrary homeservers and avoid large data-URL/IPC payloads. (`matrix_media_url`
   command returns the protocol URL; the protocol handler fetches+caches bytes.) Fallback for v1:
   temp-file under app cache + `convertFileSrc`.
4. **TLS:** `rustls-tls` on both crates (matches our existing reqwest; avoids OpenSSL cross-compile).
5. **Mobile:** the Matrix client/runtime is **all-platform** (NOT `#[cfg(desktop)]`, unlike the
   subprocess supervisors). Only **keyring** secret storage is desktop-only — on mobile fall back to
   the encrypted-store passphrase path that `secrets.rs` already provides. Pause/resume sync on app
   background/foreground via `RunEvent`.

## 10. Backend module map (from the bridge brief)
- `src/matrix/state.rs` — `MatrixState { inner: Arc<Mutex<MatrixInner>> }`; `MatrixInner` holds
  `client`, `room_list: Arc<RoomListService>`, `sync_task`/`room_list_task` AbortHandles, and
  `open_rooms: HashMap<String, OpenRoom>` (each `OpenRoom` = `Arc<Timeline>` + its diff-task AbortHandle).
- `src/matrix/diff.rs` — `DiffOp<V>` (tagged `op` enum) + `map_diff(VectorDiff<T>, &f) -> DiffOp<V>` +
  `DiffEnvelope { key, seq, diffs }`. **Pure + unit-tested** (every variant).
- `src/matrix/pump.rs` — generic `spawn_diff_pump<T,V,S>(app, channel, key, initial, stream, map_item)
  -> AbortHandle`: seeds a `Reset` from the snapshot, then drains the stream emitting one event per
  batch. Used by both room-list and every timeline.
- `src/matrix/diff_dto.rs` — `RoomDto` / `TimelineItemDto` / `ReactionDto` — small, stable, camelCase,
  **panic-free** projections (a panic in a pump silently kills it).
- `src/matrix/rooms.rs`, `src/matrix/timeline.rs` — RoomListService + per-room Timeline wiring.
- `src/matrix/session.rs` — store dir under `paths::user_data`, passphrase + tokens in `secrets.rs`
  keyring, `MatrixSession` metadata JSON via `json_store`.
- **Mutex rule:** lock → clone out `Arc<Client>`/`Arc<Timeline>` → drop guard → do async work (never
  hold the guard across a long `.await`; SDK handles are cheap `Arc` clones).
- **seq/gap handling:** `DiffEnvelope.seq` lets the renderer detect a dropped batch and re-subscribe
  to force a fresh `Reset`. Always treat `Reset` as "rebuild the local array".
