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
