# Matrix client — Element Web feature-parity checklist (master)

Exhaustive parity target derived from `element-hq/element-web` (`apps/web/src`) + `matrix-js-sdk`.
Goal: 100% feature parity, then customize. Complexity tags: **S** small/self-contained ·
**M** medium/multi-component · **L** large/cross-cutting. Phase letters refer to `specs/matrix.md` §7.

> This is the tracking checklist — tick items as they land. Keep it in sync with reality; an item is
> only checked when shipped + verified, not when scaffolded.

## 1. Authentication & account lifecycle
- [ ] Password login (M) — Phase C
- [ ] SSO / OAuth login (M) — Phase C
- [ ] OIDC-native auth (L)
- [ ] Token login (post-SSO callback, soft-logout re-auth) (S)
- [ ] Login with QR / device sign-in (MSC3906 rendezvous) (L)
- [ ] Registration + UIA stages (email, CAPTCHA, ToS, MSISDN, registration token) (L)
- [ ] Interactive Auth (UIA) engine (L)
- [ ] Homeserver + identity-server selection (M) — Phase C
- [ ] Guest access / peeking (M)
- [ ] Password reset / forgot password (M)
- [ ] Logout (with key-loss warning) (S) — Phase C
- [ ] Soft logout (token-expired re-auth) (M)
- [ ] Multi-account / account switching (L)
- [ ] Deactivate account (M)
- [ ] Session persistence / restore (L) — Phase C
- [ ] Welcome / splash / home page (S)

## 2. Room list / left panel
- [ ] Virtualized room list (M) — Phase D
- [ ] Sorting (recency / alphabetic / manual) (M) — Phase D
- [ ] Tag sublists (Favourites, People, Rooms, Low priority, Invites, Historical) (M) — Phase D
- [ ] Favourites + low-priority tagging (S) — Phase D
- [ ] Unread badges (count, dot, highlight/mention, bold) (M) — Phase D
- [ ] Notification decoration (mute/mention/activity icons) (S)
- [ ] Quick filter (people/rooms/favourites/unread + text) (M) — Phase D
- [ ] Spotlight global search (rooms/people/public dir/recent) (L)
- [ ] Breadcrumbs (recently visited) (M)
- [ ] Room context menus (general + notification) (M)
- [ ] Room tile (avatar, name, preview, ts, call summary) (M) — Phase D
- [ ] Message preview generation (M) — Phase D
- [ ] Add-room / start-chat / explore header buttons (S) — Phase H
- [ ] Left panel resize / collapse (M)
- [ ] Knock / ask-to-join bar (S)

## 3. Spaces
- [ ] Spaces panel (rail, avatars, drag-reorder) (L) — Phase H
- [ ] Space hierarchy view (nested tree) (L) — Phase H
- [ ] Space home / landing (M) — Phase H
- [ ] Create space (public/private/just-me) (M) — Phase H
- [ ] Subspaces (M)
- [ ] Add existing rooms to space (M) — Phase H
- [ ] Space settings (general/visibility/advanced) (M)
- [ ] Space preferences (S)
- [ ] Space context menu (S)
- [ ] Space invite / public share (S)
- [ ] Leave space (S)
- [ ] Suggested rooms (S)
- [ ] Meta-spaces (Home, Favourites, People, Orphans) (M) — Phase H

## 4. Timeline / room view
- [ ] Room view shell (header/timeline/composer/aux orchestration) (L) — Phase E
- [ ] Timeline panel (paginated, windowed, live) (L) — Phase E
- [ ] Plain text + linkification (M) — Phase E
- [ ] Markdown / HTML render + sanitization (L) — Phase E
- [ ] Code blocks (syntax highlight, copy) (M) — Phase E
- [ ] Emoji rendering (+ large-emoji-only) (M) — Phase E
- [ ] Mentions & pills (user/room/event/@room) (M) — Phase E
- [ ] Permalinks (matrix.to / element) (M)
- [ ] Spoilers (S)
- [ ] Replies (quote + chain) (M) — Phase F
- [ ] Threads (thread view, panel, list, activity centre) (L)
- [ ] Edits + edit history (M) — Phase F
- [ ] Reactions (picker, aggregation) (M) — Phase F
- [ ] Redaction / delete (+ bulk) (M) — Phase F
- [ ] Read receipts (avatar receipts, grouping) (M) — Phase E
- [ ] Read markers (unread line, fully-read) (M) — Phase E
- [ ] Typing indicators (S) — Phase F
- [ ] Day dividers (S) — Phase E
- [ ] Event grouping (consecutive sender, state collapse) (M) — Phase E
- [ ] State/membership event text rendering (M) — Phase E
- [ ] Jump to bottom (unread count) (S) — Phase E
- [ ] Jump to date / read receipt / first unread (S)
- [ ] Message pinning (banner + card) (M)
- [ ] Polls (create/vote/end/results/history) (L) — Phase I
- [ ] Location sharing (static + live beacons) (L) — Phase I
- [ ] Image/video/file/audio bodies (+ blurhash) (M) — Phase E/F
- [ ] Voice message playback (waveform) (M) — Phase I
- [ ] Stickers (S) — Phase I
- [ ] Lightbox / image viewer (M) — Phase E
- [ ] Message context menu (react/reply/edit/pin/forward/report/copy/source) (M) — Phase F
- [ ] Forward message (M)
- [ ] View source / devtools on event (S)
- [ ] Report message / report room (S)
- [ ] URL previews (M)
- [ ] Room preview bar (peek/invite accept-reject) (M) — Phase H
- [ ] New room intro (S)
- [ ] Room predecessor / upgrade tile (S)
- [ ] File panel (per-room files) (S)
- [ ] Notification panel (M)
- [ ] Live content / call summary banners (S)

## 5. Composer
- [ ] Plain/markdown composer (contenteditable model) (L) — Phase F
- [ ] WYSIWYG composer variant (L)
- [ ] Formatting toolbar (bold/italic/strike/code/quote/link) (M) — Phase I
- [ ] Emoji picker (searchable, categories, recents, custom) (M) — Phase I
- [ ] Mentions autocomplete (users/rooms/@room/emoji/commands) (L) — Phase I
- [ ] Slash commands (full set: /me, /spoiler, /invite, /op, /topic, …) (L) — Phase I
- [ ] File/image upload (picker + drag-drop + paste) (L) — Phase F
- [ ] Upload progress / cancel / failure (S) — Phase F
- [ ] Stickers picker (M) — Phase I
- [ ] Voice messages (record/waveform/send) (L) — Phase I
- [ ] Emoticon autoreplace (`:)` → 😄) (S)
- [ ] Drafts (persist per room/thread) (M)
- [ ] Send history (up/down recall) (S)
- [ ] Reply preview in composer (S) — Phase F
- [ ] Edit composer (inline) (M) — Phase F
- [ ] Composer buttons / overflow menu (M) — Phase F
- [ ] Spell check config (S)
- [ ] @room confirm before mass mention (S)

## 6. Encryption (E2EE)
- [ ] E2EE message rendering + padlock states + icon (M) — Phase G
- [ ] Room encryption toggle (S) — Phase G
- [ ] Cross-signing setup (master/self/user-signing) (L) — Phase G
- [ ] Device verification — SAS emoji (L) — Phase G
- [ ] Device verification — QR (M) — Phase G
- [ ] Manual device key verification (S)
- [ ] Verify current session at login ("complete security") (M) — Phase G
- [ ] Key backup (server-side) create/restore/enable (L) — Phase G
- [ ] Recovery key / passphrase (generate/store/change/reset) (L) — Phase G
- [ ] 4S (Secure Secret Storage) bootstrap & access (L) — Phase G
- [ ] Reset identity / crypto (M) — Phase G
- [ ] Delete key storage (S)
- [ ] UTD handling ("unable to decrypt" tiles + tracking) (M) — Phase G
- [ ] Device/session trust indicators (shields) (M) — Phase G
- [ ] User identity change warnings (M)
- [ ] Encryption settings tab (M) — Phase K
- [ ] Megolm/Olm session mgmt (/discardsession) (S)
- [ ] Seshat (encrypted search) reset (S)

## 7. Room settings & management
- [ ] Create room (name/topic/alias/visibility/E2EE/federation) (M) — Phase H
- [ ] Invite users (multi + 3pid email + suggestions) (L) — Phase H
- [ ] Ask-invite-anyway / decline-and-block guards (S)
- [ ] Membership management (kick/ban/unban/invite-rules) (M) — Phase H
- [ ] Power levels / roles (M) — Phase H
- [ ] Room name / topic / avatar (S) — Phase H
- [ ] Room aliases / addresses (canonical + local + published) (M)
- [ ] Room visibility / join rules (public/invite/restricted/knock) (M) — Phase H
- [ ] Room directory publish (S)
- [ ] Room directory / explore (browse + search public) (M) — Phase H
- [ ] Per-room notifications (M)
- [ ] Room settings dialog (tabbed shell) (M) — Phase H
- [ ] People room settings tab (S)
- [ ] Advanced room settings (internal id/federation/version) (S)
- [ ] Room upgrade (+ migration) (M)
- [ ] Convert DM ↔ room (S)
- [ ] Leave room (S) — Phase H
- [ ] Widgets (add/configure/remove, apps drawer, capabilities, modal, scalar, PiP) (L)
- [ ] Integration manager (Dimension/Scalar) (L)
- [ ] Bridges info (S)
- [ ] Room member / user info card (profile/power/verify/ignore/kick) (M) — Phase H
- [ ] Room summary card (info/people/files/pins/extensions/settings) (M) — Phase H
- [ ] 3pid member info (pending email invite) (S)

## 8. Voice / video calls
- [ ] 1:1 legacy WebRTC calls (L) — Phase J
- [ ] Group calls — Element Call (MatrixRTC widget) (L) — Phase J
- [ ] Call controls (mute/hold/hangup/dialpad) (M) — Phase J
- [ ] Screen sharing (M) — Phase J
- [ ] Picture-in-Picture (M) — Phase J
- [ ] Call duration / status UI (S) — Phase J
- [ ] Audio/video feeds rendering (M) — Phase J
- [ ] VoIP / PSTN dialpad (M)
- [ ] Device selection (mic/cam/speaker) (M) — Phase J
- [ ] Incoming call toasts / ringing (S) — Phase J
- [ ] Livestream / Jitsi (M)

## 9. User settings
- [ ] Settings dialog shell (tabbed) (M) — Phase K
- [ ] Account tab (display name, 3pids, password, deactivate) (M) — Phase K
- [ ] Profile & personal info (avatar, name, timezone) (M) — Phase K
- [ ] Appearance / themes (light/dark/custom, font scale, layout, image size) (M) — Phase K
- [ ] Preferences tab (M) — Phase K
- [ ] Notifications tab (push rules/keywords/sounds) (L)
- [ ] Security & privacy tab (M) — Phase K
- [ ] Session manager (list/rename/verify/sign-out devices, QR sign-in) (L) — Phase K
- [ ] Encryption tab (recovery/key storage/reset) (M) — Phase K
- [ ] Labs / beta features (M)
- [ ] Keyboard shortcuts (M)
- [ ] Sidebar settings (S)
- [ ] Voice & video settings (S) — Phase J
- [ ] Mjolnir / ignored-user ban lists (M)
- [ ] Discovery / identity server (M)
- [ ] Media preview controls (S)
- [ ] Help / about tab (version/clear cache/bug report/legal) (S) — Phase K
- [ ] Layered settings store infra (L) — Phase K
- [ ] Quick settings button (S)

## 10. Notifications
- [ ] Desktop / web push notifications (L)
- [ ] Notification badges & counts (app/favicon badge) (M)
- [ ] Push rules engine (server eval + editing) (L)
- [ ] Keyword / mention notifications (S)
- [ ] Notification sounds (S)
- [ ] Toasts (urgent + non-urgent) (M)
- [ ] Release announcements (S)
- [ ] Unread/notification state computation (room/thread/space) (L) — Phase D

## 11. Search
- [ ] In-room message search (server-side + highlights) (M) — Phase I
- [ ] All-rooms search (M)
- [ ] Local encrypted search (Seshat offline index) (L)
- [ ] Spotlight / global search (L)
- [ ] Search box / filtering UI (S) — Phase I

## 12. Misc / platform
- [ ] Presence (online/offline/unavailable, last-active) (M)
- [ ] Custom status message (/status) (S)
- [ ] Ignore / block users (/ignore, /unignore) (S)
- [ ] Share dialog (room/user/event links + QR) (S)
- [ ] Export chat (HTML/JSON/plaintext + media) (M)
- [ ] Bug report / rageshake (M)
- [ ] Feedback dialogs (S)
- [ ] Devtools (event explorer/state viewer/settings explorer) (M)
- [ ] Analytics / telemetry (PostHog opt-in) (M)
- [ ] Error reporting (Sentry) (S)
- [ ] i18n / localization (L)
- [ ] Keyboard navigation / accessibility (M)
- [ ] Modules / extensibility API (L)
- [ ] Customisations / branding (white-label) (M) — *our customization layer hooks here*
- [ ] Storage / cache management (clear cache, storage-evicted) (M)
- [ ] Server offline / sync error handling (S) — Phase C
- [ ] User activity / idle detection (S)
- [ ] Notification/effects (confetti/fireworks/snow) (S)
- [ ] Terms & conditions handling (S)
- [ ] Generic dialog primitives (base/question/error/info/text-input) (S) — Phase B/E
- [ ] Desktop platform integration (tray, native notifs, auto-update, deep links) (L) — *Tauri equivalents*
- [ ] Voice broadcast (labs) (L)

---

**Count:** ~190 line items. Tracking note: many "L" items (widgets, integration manager, OIDC,
Seshat, push rules, i18n) are large subsystems we deprioritize until the core chat loop (Phases C–G)
is solid. The customization layer lives at item 12 "Customisations / branding" — that's the seam we
keep clean so re-skinning is localized.
