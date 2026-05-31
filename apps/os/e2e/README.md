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

### Headless / CI

```bash
npm run test:headless         # uses xvfb-run when available, else runs direct
npm run test:headless:build   # build the binary first, then headless run
```

`scripts/e2e-headless.sh` wraps the run in `xvfb-run` on Linux/CI (the Tauri
WebKitGTK window renders into a virtual framebuffer with no display attached).
**On macOS there is no Xvfb** — Apple's window server has no detachable
framebuffer — so the script runs directly and the window appears; a macOS CI
runner therefore needs a logged-in GUI session.

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
| `09.links` | external links view — card count + safe `https`/`_blank`/`noopener` hrefs |
| `10.theme` | light/dark toggle flips `data-theme` + persists `srwk:theme` |

### Coverage boundary

The `graph-only` surface (`#sidebar`, events panel, peers panel, anon badge,
wire timeline, `#cosmos-view`, `#cartography-view`) is **not reachable through
the four top tabs** in this build — opening the apps tab shows the grid/atlas,
not that legacy graph view — so it isn't exercised by UI tests. If a navigation
path to it is added, add specs then. The native menu (Hermes window) is also
out of scope: tauri-wd can't drive the macOS app menu.

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

## Driver quirks worked around (tauri-wd 0.1.x)

- **No element refs into `execute`.** The plugin does not rehydrate a WebElement
  passed as an argument to `execute`, so WebdriverIO's built-in visibility path
  (`isDisplayed` / `toBeDisplayed` / `waitForDisplayed`) throws
  `Argument 1 ('other') to Node.contains must be an instance of Node`. We never
  use those — `helpers/app.mjs` checks visibility via `execute` with a **selector
  string** (`isVisible` / `waitVisible` / `waitHidden`). Keep new specs on those
  helpers; don't reach for `toBeDisplayed`.
- **Sessions don't always reap the app.** Deleting a session doesn't reliably
  terminate the binary `tauri-wd` spawned, so the config reaps stray
  `…/target/debug/shape-rotator-os` processes in `afterSession`/`onComplete`
  (matched by the exact debug path, so your installed app is never touched).
- **The window race (the big one).** `tauri-wd` announces the plugin's port —
  and WebdriverIO immediately queries the window handle — *before* the Tauri
  window is created (config windows are created after all plugin inits). So the
  first `newSession` can fail with `no window`. Two things make this robust:
  1. The plugin is registered **on the builder** (`src-tauri/src/lib.rs`), NOT
     at runtime — runtime registration fixes the race but the init script
     (`window.__WEBDRIVER__`) never injects, so every `execute` then hangs.
  2. `connectionRetryCount: 10` in the config. `tauri-wd` keeps the spawned app
     alive across retries, so a retry finds the now-created window. This is what
     makes runs succeed **even under heavy machine load** — no need to wait for
     an idle box.
  `helpers/app.mjs` then gates on `waitForWindow()` (polls `getWindowHandle`,
  the singular `GET /window`; the plural `getWindowHandles` is unimplemented and
  404s) and `waitForRenderer()` (polls readiness via `execute`, tolerating the
  transient "script timed out" while the three.js renderer boots).
- **WebdriverIO v9 required.** v8's `getWindowHandle` 404s against tauri-wd's
  W3C subset. Stay on `@wdio/* ^9`.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `no window` at session creation | The window race. Ensure `connectionRetryCount: 10` is set and the plugin is registered on the builder (not at runtime). Retries absorb it even under load. |
| `App did not report plugin port in time` | The plugin isn't in the binary — something rebuilt `target/debug/shape-rotator-os` without `--features webdriver`. Re-run `npm run build:app` (rebuilds the isolated `-e2e` copy). |
| `script timed out` on `execute`/`element` | Bridge not injected — the plugin was registered at runtime instead of on the builder. Keep build-time registration. |
| `Node.contains must be an instance of Node` | A spec used `toBeDisplayed`/`isDisplayed`. Switch it to `waitVisible`/`isVisible`. |
| `tauri-wd: command not found` | `cargo install tauri-webdriver-automation --locked`; ensure `~/.cargo/bin` is on `PATH`. |
| Many lingering `shape-rotator-os` processes | A run was killed mid-flight; `pkill -f "src-tauri/target/debug/shape-rotator-os"`. |
| Atlas/network show "offline" | `swf-node` isn't up. Specs tolerate this; start the daemon for fully-live data, or set `SWF_NODE_DISABLE=1` to skip it deliberately. |
