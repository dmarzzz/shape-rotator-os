[![latest release](https://img.shields.io/github/v/release/dmarzzz/shape-rotator-os)](https://github.com/dmarzzz/shape-rotator-os/releases/latest)

# shape rotator os

Local-first Electron app for the Shape Rotator cohort. Four tabs:

- **alchemy** — the cohort view: feed of github activity across team repos, shape grid (every team/project as a card), pulse + constellation visualizations, and a profile editor that submits your edits as PRs against this repo.
- **atlas** — wall-map of every page indexed locally by your swf-node, clustered into territories. Search overlay (`⌘/`) routes through swf-node's `/web_search`.
- **network** — live peer view (LAN + DC-net rounds + receipts) plus a metrics sub-tab pulling from `/metrics/snapshot` + `/metrics/series`.

The app is a viewer over [`swf-node`](https://github.com/dmarzzz/searxng-wth-frnds), the LAN-first peer search daemon. Without swf-node running, atlas + network + search are disabled but alchemy still works (cohort data ships in `cohort-data/`).

## install

Grab the latest build from [releases/latest](https://github.com/dmarzzz/shape-rotator-os/releases/latest).

- **macOS** — download the `.dmg` matching your chip (`mac-arm64` for Apple Silicon, `mac-x64` for Intel). Until the app is code-signed, after dragging to /Applications run `xattr -cr "/Applications/Shape Rotator OS.app"` once to clear macOS quarantine.
- **Windows** — download the `.exe` (`win-x64` or `win-arm64`). First launch may show a SmartScreen warning: click "More info" → "Run anyway".
- **Linux** — download the `.AppImage` (`chmod +x <file>` then run, no install) or the `.deb` (`sudo dpkg -i <file>`). Pick the arch that matches your box (`x86_64`/`amd64` or `arm64`).

Updates are click-to-install — click the version chip in the top-right of the app. Windows + Linux AppImage get the seamless one-click flow; macOS + Linux .deb get the v0.1.11 "download + open installer" flow until signing is wired.

## what's in here

```
apps/
  os/                 ← the Electron app (main + renderer)
  web/                ← sibling marketing site

packages/
  shape-ui/           ← shared SHAPES vocabulary + SVG generator

cohort-data/          ← markdown source of truth for the cohort
  schema.yml          ← surface_fields whitelist per record_type
  teams/<slug>.md     ← teams + projects (kind: team | project)
  clusters/<slug>.md  ← synergy clusters across teams

scripts/
  build-bundles.js    ← cohort-data/ → apps/os/src/cohort-surface.json
  publish-bundles.js  ← sign + POST cohort.surface bundles to swf-node
  keys-gen.js         ← generate an Ed25519 alchemist signing key
```

## run from source

```bash
npm install
npm run os
```

You'll need swf-node running on `127.0.0.1:7777` (default) for atlas / network / search; alchemy works offline against the bundled cohort fixture.

## edit your record

Open the app → profile tab → pick `EDIT` (existing record) or `ADD` (new). Submit opens a GitHub PR against this repo — once merged, run `npm run publish:cohort` to push the new surface bundles to your swf-node.

The depth fields (status, blockers, decision logs) live only in alchemist worktrees and are encrypted into `cohort.depth` bundles before reaching the wire — they never appear in this repo.

## profile data model

Every record in `cohort-data/` has two layers per [`docs/SHAPE-ROTATOR-OS-SPEC.md` §3.3](https://github.com/dmarzzz/searxng-wth-frnds):

- **surface** — the public fields whitelisted in `schema.yml`. Visible to all cohort participants. What's in this repo.
- **depth** — alchemist-only fields (intake notes, blockers, decisions). Lives in the alchemist worktree, encrypted into `cohort.depth` bundles.

Adding a new public field: add it to the markdown frontmatter + add the key to `schema.yml`. Anything not in the whitelist stays steward-only.
