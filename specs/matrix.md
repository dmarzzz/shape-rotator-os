# Spec: Matrix client ("matrix" tab) in Shape Rotator OS

Status: **DRAFT (v0.1)** — research in flight; SDK snippets + full parity checklist finalized as the
`matrix-research` workflow lands. Architecture and integration points below are verified against the
current codebase.

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

### 3.1 Crates (Phase B will pin exact versions)
```toml
matrix-sdk        = { version = "0.17", default-features = false, features = ["e2e-encryption", "sqlite", "rustls-tls", "markdown"] }
matrix-sdk-ui     = { version = "0.17", default-features = false, features = ["e2e-encryption", "native-tls"... ] } # reconcile TLS with above
# matrix-sdk-sqlite pulled transitively via the "sqlite" feature
```
(We already depend on `tokio` multi-thread, `reqwest` rustls, `serde`/`serde_json`, `keyring`,
`dirs`/`tauri` app-data paths — reused here.)

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

> Filled/expanded from the `element-features` research agent + `reference/element-web/apps/web/src`.
> Tags: **S/M/L** effort. Phasing in §7. (Placeholder — research output merged on landing.)

- [ ] **Auth**: password login · SSO/OAuth · homeserver discovery · session restore · logout · (later) registration, multi-account
- [ ] **Room list**: list + sort · unread badges · favourites/low-priority · filters (people/rooms/unread) · search · breadcrumbs
- [ ] **Spaces**: spaces panel · hierarchy · room↔space membership
- [ ] **Timeline**: text/markdown/code/emoji · mentions/pills · replies · threads · edits · reactions · redaction · read receipts & markers · typing · day dividers · event grouping · jump-to-bottom · permalinks · pinning · polls · location
- [ ] **Composer**: markdown · emoji picker · mentions autocomplete · slash commands · file/image upload & paste · voice messages · stickers · formatting toolbar · drafts
- [ ] **Encryption**: E2EE indicators · device verification (SAS/QR) · cross-signing · key backup · recovery (4S) · UTD handling · room encryption toggle
- [ ] **Room admin**: create · invite · membership/roles/power levels · name/topic/avatar · directory · per-room notifications · aliases · widgets
- [ ] **Calls**: 1:1 voice/video · group calls (Element Call) · screen share
- [ ] **Settings**: profile · appearance/themes · notifications · security/privacy · labs · sessions/devices management
- [ ] **Misc**: message search · presence/status · share · export chat

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

## 9. Open questions (resolve as research lands)
1. Exact pinned `matrix-sdk` / `matrix-sdk-ui` version + feature flags + MSRV bump?
2. `sync_service::SyncService` vs raw sliding sync — confirm the recommended desktop pattern.
3. Media delivery: Tauri custom protocol vs temp files vs data URLs (size/perf/CSP trade-off).
4. TLS feature reconciliation between `matrix-sdk` (we use rustls elsewhere) and `matrix-sdk-ui`.
5. Mobile: which subsystems are `#[cfg(desktop)]` (keyring) vs universal (the client itself).
