# Shape Rotator OS — Tauri mobile (iOS / Android) setup

The Tauri backend is written to be **mobile-ready**: `src-tauri/src/lib.rs` exposes
a shared `run()` with `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, and every
subsystem that needs a child process or native lib — the local **swf-node** daemon,
the **research-agent** swarm, the **NDI sidecar**, and **auto-update** — is gated
behind `#[cfg(desktop)]`. On iOS/Android those commands return `"unsupported"` /
`available:false`, and the renderer already hides the corresponding UI. Everything
that the mobile OS *does* allow works: the full renderer, prefs, clipboard,
open-URL, context-vault reads, and talking to a **remote** swf-node over HTTPS
(set via `SWF_NODE_URL` / the `env_get` `serverUrl`).

## What runs where

| Feature | macOS / Linux / Windows | iOS / Android |
|---|---|---|
| Renderer (atlas, alchemy, calendar, profile, network views) | ✅ | ✅ |
| prefs / clipboard / open-external / context-vault | ✅ | ✅ |
| swf-node local daemon | ✅ (sidecar) | ❌ → use remote `SWF_NODE_URL` |
| research-swarm | ✅ (sidecar) | ❌ (no subprocess) |
| easel / NDI projection | ✅ (Node sidecar) | ❌ (no Node, no NDI) |
| auto-update | ✅ (tauri-updater) | ❌ (App Store / Play Store) |

## Prerequisites (NOT present on the current dev machine)

**iOS** (macOS host only):
- **Full Xcode** (App Store) — Command Line Tools alone are insufficient.
  `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`
- **CocoaPods**: `brew install cocoapods`
- Rust targets (already added): `aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios`

**Android** (any host):
- **JDK 17** (`brew install openjdk@17`), **Android Studio** (SDK + Platform-Tools),
  and the **NDK**. Export:
  `export JAVA_HOME=…`, `export ANDROID_HOME=~/Library/Android/sdk`,
  `export NDK_HOME=$ANDROID_HOME/ndk/<version>`
- Rust targets (already added): `aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`

## Initialize the platform projects (run from `apps/os/`)

```bash
# iOS — generates src-tauri/gen/apple/ (Xcode project)
npm run tauri:ios:init        # = tauri ios init

# Android — generates src-tauri/gen/android/ (Gradle project)
npm run tauri:android:init    # = tauri android init
```

These create `src-tauri/gen/apple` and `src-tauri/gen/android`. Commit them (or
regenerate in CI). They pick up the identifier `com.shape-rotator.os`, the icons
already generated under `src-tauri/icons/` (the `tauri icon` run produced the iOS
`AppIcon-*` and Android `mipmap-*` sets), and the `frontendDist` from
`tauri.conf.json` (built by `scripts/tauri-prebuild.cjs`).

## Run / build

```bash
npm run tauri:ios:dev          # boot in the iOS Simulator
npm run tauri:ios:build        # .ipa  (needs an Apple signing team)
npm run tauri:android:dev      # boot in an Android emulator / device
npm run tauri:android:build    # .apk / .aab
```

## Mobile-specific config to add at init time

- **iOS `Info.plist`** (Tauri merges `src-tauri/gen/apple/<app>_iOS/Info.plist`):
  add `NSLocalNetworkUsageDescription` + `NSBonjourServices` so the renderer can
  reach a remote swf-node / cohort peers on the LAN (same string as the desktop
  `NSLocalNetworkUsageDescription`).
- **Android `AndroidManifest.xml`**: ensure `<uses-permission android:name="android.permission.INTERNET"/>`
  (Tauri adds this by default).
- **CSP**: the shared `app.security.csp` in `tauri.conf.json` already allows the
  remote hosts (`*.phala.network`, GitHub raw/api) and loopback; no mobile change
  needed. The easel `ws://127.0.0.1:*` entry is harmless on mobile (unused).

## Verifying the mobile crate compiles (no device needed)

With the SDKs installed you can type-check the mobile build without a device:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android
```

(These need the iOS SDK / Android NDK on PATH respectively; the desktop-only
crates `keyring`, `tauri-plugin-updater`, `tauri-plugin-process`, and `nix` are
excluded from the mobile dependency set in `Cargo.toml` via `target_os` gates.)
