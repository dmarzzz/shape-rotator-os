# installing Shape Rotator OS (the Electron app)

The cohort viewer + profile editor for the program. Local-first, no
server. Builds for macOS, Windows, and Linux.

Grab the latest from **[releases/latest](https://github.com/dmarzzz/shape-rotator-os/releases/latest)**.

Pick the asset that matches your machine:

| platform | file |
|---|---|
| macOS — Apple Silicon (M1/M2/M3/M4) | `ShapeRotatorOS-<version>-mac-arm64.dmg` |
| macOS — Intel | `ShapeRotatorOS-<version>-mac-x64.dmg` |
| Windows — x64 | `ShapeRotatorOS-<version>-win-x64.exe` |
| Windows — ARM | `ShapeRotatorOS-<version>-win-arm64.exe` |
| Linux — recommended (single binary, auto-update) | `ShapeRotatorOS-<version>-linux-x86_64.AppImage` |
| Linux — system install via dpkg | `ShapeRotatorOS-<version>-linux-amd64.deb` |
| Linux — ARM AppImage | `ShapeRotatorOS-<version>-linux-arm64.AppImage` |
| Linux — ARM deb | `ShapeRotatorOS-<version>-linux-arm64.deb` |

---

## ⚠️ macOS — extra step (required)

The Electron bundle is **not code-signed**, so macOS Gatekeeper will
refuse to open it with a misleading "Shape Rotator OS is damaged and
can't be opened" error.

To fix this — once, after install — open Terminal and run:

```bash
xattr -cr "/Applications/Shape Rotator OS.app"
```

That clears the macOS quarantine attribute. Then open the app
normally from /Applications or Spotlight.

This step won't be needed once we land an Apple Developer signing
cert; the workflow already supports it (see
[.github/workflows/os-release.yml](../.github/workflows/os-release.yml))
and just needs the five secrets to be filled in.

### macOS install steps in order

1. Download the `.dmg` matching your chip (arm64 for M-series, x64 for Intel).
2. Double-click the .dmg — a Finder window opens.
3. Drag **Shape Rotator OS** to **/Applications** (replacing any old version).
4. Open Terminal and run the `xattr -cr` command above.
5. Open the app from /Applications or Spotlight.

---

## Windows

1. Download the `.exe` installer.
2. Run it. If SmartScreen warns ("Windows protected your PC"), click
   **More info** → **Run anyway** (we're unsigned for now).
3. The NSIS installer walks you through; the app lands in Program
   Files and is reachable from the Start menu.

Future updates are seamless via the version chip → "download +
install" — `electron-updater` swaps the binary on next quit.

---

## Linux

**AppImage (recommended)** — single portable binary with seamless
in-app updates:

```bash
chmod +x ShapeRotatorOS-<version>-linux-x86_64.AppImage
./ShapeRotatorOS-<version>-linux-x86_64.AppImage
```

**.deb (Debian/Ubuntu)** — system install via dpkg. Auto-update needs
sudo, so the in-app flow opens the file manager and tells you what to
run:

```bash
sudo dpkg -i ShapeRotatorOS-<version>-linux-amd64.deb
# launch:
shape-rotator-os
```

---

## auto-update

Once you're installed, click the version chip at the bottom-left of
the app to check for updates. The flow depends on the build:

- **Windows** + **Linux AppImage** — one-click seamless: app
  downloads + restarts on the new version.
- **macOS** + **Linux .deb** — the app downloads the installer to
  `~/Downloads/` and opens it for you (mac: dmg auto-mounts with the
  drag-to-Applications Finder window). macOS will require the
  `xattr -cr` step again after each upgrade until we sign the app.

---

## one-line install via the field-kit

If you're already running [shape-rotator-field-kit](https://github.com/dmarzzz/shape-rotator-field-kit):

```bash
rotate install-app
```

That picks the right asset for your platform, downloads it, copies to
/Applications (mac) or runs `dpkg -i` (linux), and clears macOS
quarantine automatically. Windows users still grab the installer from
the release page.

---

## peer search + atlas (mac + linux only for now)

macOS and Linux installs auto-bundle swf-node as a managed subprocess,
so peer search, atlas, network view, and metrics all work out of the
box on first launch. Windows installs run in degraded mode: the cohort
viewer and profile editing still work, but the swf-node-backed
features (search, atlas, peer presence) are disabled until upstream
swf-node ships a Windows runtime. Tracked at
[dmarzzz/shape-rotator-os#84](https://github.com/dmarzzz/shape-rotator-os/issues/84).

---

## what to expect on first launch

On macOS/Linux the bundled daemon takes ~10–15 seconds to extract itself
on the very first open (PyInstaller cold-start). After that, normal
launches are sub-second.

Once the daemon is up, the app:

1. **Announces itself on your LAN via mDNS.** The cohort runs on the
   same WiFi network during the program; other cohort members' apps
   discover yours automatically — no signup, no central server.
2. **Bootstraps a local cohort-keys file** under
   `~/Library/Application Support/Shape Rotator OS/swf-node-data/`
   (mac) or the equivalent on Linux. The trust model defaults to
   "trust anyone on this LAN" — appropriate for an in-person cohort.
   Profiles edited in the app sign locally and propagate to your
   neighbors within ~30 seconds.
3. **Falls back to GitHub** for the initial cohort surface (people,
   teams, asks, the program calendar). The bundled local fixture is
   used if GitHub is unreachable.
4. **Surfaces live network activity** in the **Network** tab — peer
   discovery, manifest fetches, record propagation, search activity.
   The TRAFFIC panel is the unified message stream; PEERS lists your
   discovered neighbors with live/stale/down status; SYNC shows the
   total record + peer-reachable count at a glance.

You don't need to set up anything else. Open the app, open the
**Network** tab, watch the TRAFFIC list pulse every 30s as the sync
loop ticks. When another cohort member joins on the same WiFi, you'll
see an `mdns_peer_appeared` row land in real time.

### the two edit paths

Profile edits can travel two ways:

- **Live sync (default when swf-node is healthy):** edits POST to the
  local daemon's `/sync/local_record` endpoint, get signed with your
  device key, and propagate to LAN neighbors within one sync tick. No
  GitHub round-trip.
- **GitHub PR fallback:** if the daemon is down or you're on a network
  with no cohort members, the editor falls back to opening a PR
  against `cohort-data/people/<your-handle>.md`. Once merged, all apps
  pick up the change on their next refresh.

In normal use you won't notice which path is active — the editor
chooses for you.
