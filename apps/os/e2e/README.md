# Shape Rotator OS — end-to-end tests (macOS)

WebdriverIO specs that drive the **real Tauri build** of Shape Rotator OS on
macOS, where Apple ships no native `WKWebView` WebDriver. We bridge that gap
with [`tauri-webdriver-automation`](https://github.com/danielraffel/tauri-webdriver):
a Tauri plugin that injects a W3C WebDriver server into the webview, plus a
`tauri-wd` CLI that translates standard WebDriver commands to it.

```
WebdriverIO  ──W3C──▶  tauri-wd (:4444)  ──HTTP──▶  plugin inside the WKWebView
   specs                  CLI server                  (debug builds only)
```

## How it's wired

- **`src-tauri/Cargo.toml`** — adds `tauri-plugin-webdriver-automation` as an
  *optional* dep behind a `webdriver` feature.
- **`src-tauri/src/lib.rs`** — registers the plugin under
  `#[cfg(feature = "webdriver")]`. It is **impossible** for this to reach a
  release/notarized build: release builds don't pass `--features webdriver`.
- **`wdio.conf.mjs`** — spawns/kills `tauri-wd` and points it at the debug
  binary. Mocha + spec reporter.
- **`helpers/`** — `selectors.mjs` (one source of truth, mirrors `index.html`)
  and `app.mjs` (navigation helpers + the write-gate flag).

## One-time setup

```bash
# 1. the WebDriver CLI (Rust)
cargo install tauri-webdriver-automation --locked   # provides `tauri-wd`

# 2. the e2e node deps
cd apps/os/e2e
npm install
```

## Run

```bash
cd apps/os/e2e
npm test            # builds the debug binary (--features webdriver) then runs
npm run test:nobuild  # skip the rebuild if the binary is already current
```

`npm test` runs `build:app` first, which bundles the frontend
(`scripts/tauri-prebuild.cjs`) and compiles
`src-tauri/target/debug/shape-rotator-os` with the `webdriver` feature. The app
serves its frontend from the embedded `dist-frontend` (the Tauri config has no
`devUrl`), so **no separate dev server is needed**.

## What's covered

| Spec | Area |
|------|------|
| `00.boot` | window opens, renderer boots, version chip resolves |
| `01.navigation` | four top tabs switch, `aria-selected`, persistence |
| `02.operating-system` | every alchemy rail mode mounts; membrane WebGL |
| `03.apps-atlas-easel` | apps grid → atlas/easel, back nav, atlas states, help |
| `04.network-metrics` | network/metrics sub-tabs, glance/debug, traffic, peers |
| `05.search` | search overlay, policy/top_k, a live **local** query |
| `06.swarm` | "ask my agent" modal + settings sub-modal |
| `07.command-palette` | ⌘K palette, type-to-filter, Esc, `?` overlay |
| `08.profile-and-updates` | live update check; profile editor (write-gated) |

## Live dependencies & safety

The suite runs **fully live** (real `swf-node` daemon, real network) as
requested. Two guards keep it from causing irreversible side effects:

- **No public egress.** The search spec leaves "allow public egress" **off**, so
  queries stay local/cohort and nothing leaves the network.
- **No real writes by default.** Anything that opens a real GitHub PR (the
  profile/fork flow) is gated behind an env flag:

  ```bash
  SRWK_E2E_ALLOW_WRITES=1 npm run test:nobuild
  ```

  With the flag off (default), the profile spec verifies the editor surface
  mounts and **stops before submitting**. Before enabling writes, confirm the
  PR submit selector against `renderer/alchemy.js` (`wireProfileForm()`) and
  `renderer/gh-fork.js` and complete the gated test — it currently throws if you
  enable writes without wiring that selector, by design.

Counts (peers, pages, traffic) are asserted structurally, never by magnitude —
a quiet network with zero peers is a valid live state.

## Notes / gotchas

- `07.command-palette` sends synthetic OS key chords through the bridge — the
  most driver-sensitive specs. If a `tauri-webdriver` build can't deliver key
  events, quarantine that file (`--spec`) rather than the whole run.
- The driver attaches to the **debug** binary only; the plugin never starts in
  release.
- Pin `tauri-plugin-webdriver-automation` and `tauri-wd` to the same version —
  check crates.io for the current `0.x`.
