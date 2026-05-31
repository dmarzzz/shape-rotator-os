# Spec: Agent tab (local Codex / Claude Code) in Shape Rotator OS

Status: **v0.1 — design only, not scheduled.** Architecture sketched from a 3-agent
codebase exploration (renderer/easel pattern, specs house style, in-app data inventory).
Integration points verified against the current Tauri codebase. **No code to be written yet.**

> Goal: a new **agent** app view in `apps/os` that runs the user's *own local* Codex
> and/or Claude Code instance inside the app, in a real terminal, with first-class access
> to the app's data (cohort surface, live P2P sync, GitHub) through a local **MCP server**.
> The agent uses the user's machine and the user's credentials — we run no inference and
> hold no model keys.

---

## 1. Why this shape

We already migrated `apps/os` from Electron → Tauri 2 (see `~/.claude/memory/tauri-migration.md`).
The renderer is vanilla JS talking to a Rust backend via `window.__TAURI__.core.invoke` +
`event.listen`, bridged by `apps/os/src/api-shim.js`. Three constraints shape this design:

- **Local-first / bring-your-own-agent.** The user already has `claude` and/or `codex`
  installed and authenticated. We spawn *their* binary as a subprocess — no embedded model,
  no API keys in the app, no server-side inference. The agent inherits the user's auth.
- **Real CLI, not a re-implementation.** Both tools ship rich interactive TUIs. We run the
  genuine binary in a PTY and paint it with xterm.js, rather than rebuilding a chat client.
  This is the `supervisor/swarm.rs` subprocess pattern upgraded from line-pipes to a PTY.
- **MCP is the data bridge.** Both Claude Code and Codex are MCP clients. Instead of dumping
  stale context into a prompt, the app exposes a small **MCP server** that wraps the data the
  app *already* fetches. The agent pulls live cohort/sync/GitHub data on demand, as tools.

### Data the app already holds (the MCP server is a thin façade over these)
- **Cohort surface** — `apps/os/src/renderer/cohort-source.js`, bundled
  `apps/os/src/cohort-surface.json`, live copy in localStorage `srfg:cohort_surface_v1`.
  Schema: `cohort-data/schema.yml` (people, teams, clusters, events, asks, program).
- **Live P2P sync (swf-node)** — HTTP on `localhost:7777`: `GET /sync/manifest`,
  `GET /sync/record/<id>`. Spawned/managed by `apps/os/swf-node.js`; bearer token from
  `getSwfAgentToken()` (persisted at `userData/swf-node-data/agent_token`).
- **GitHub** — `apps/os/src/renderer/gh-user.js` (user enrichment, 24h cache),
  `apps/os/src/renderer/gh-fork.js` (fork → PR flow). Unauthenticated `api.github.com`
  against `dmarzzz/shape-rotator-os` (60 req/hr/IP; no token persisted today).
- **Local identity & prefs** — localStorage `srwk:identity_v1` (claimed person/team),
  prefs file via `prefs:load`/`prefs:save`.

---

## 2. Architecture overview

```
┌───────────────────────────── webview (renderer, vanilla JS) ──────────────────────────────┐
│  agent app view  ─►  src/renderer/agent.js                                                  │
│     • xterm.js terminal painted into #agent-stage (+ @xterm/addon-fit)                       │
│     • keystrokes ─► window.api.agent.write(bytes);  resize ─► window.api.agent.resize(c,r)    │
│     • renders PTY bytes streamed back from backend                                            │
└───────────────▲───────────────────────────────────────────────┬───────────────────────────┘
   event.listen │ agent://pty-data, agent://status                │ invoke(agent_*)
   (pty stream) │                                                  │ (spawn/write/resize/kill)
┌───────────────┴───────────────────────────────────────────────▼───────────────────────────┐
│  Tauri backend (Rust)  ─►  src-tauri/src/commands/agent.rs  +  src-tauri/src/agent/*.rs      │
│     • resolve_agent_binary(): detect `claude` / `codex` (HOME, PATH, resource dir, env)      │
│     • spawn in PTY (portable-pty); write per-backend MCP config to a temp profile             │
│     • pump PTY master → app.emit("agent://pty-data");  exit → app.emit("agent://status")      │
└───────────────┬──────────────────────────────────────────────────────────────────────────────┘
                │  the spawned CLI connects to our MCP server as one of its MCP servers
                ▼
┌─────────────────────────────  in-app MCP server (stdio or 127.0.0.1)  ──────────────────────┐
│  src-tauri/src/agent/mcp.rs  — read-mostly tools over existing data sources:                 │
│     cohort_search · cohort_get_record · sync_manifest · sync_get_record ·                    │
│     github_user · identity_whoami · prefs_get   │   writes (open_pr_draft, sync_push)         │
│     are gated behind an explicit in-app confirmation prompt                                    │
│        └─► cohort-surface.json / swf-node :7777 (bearer) / api.github.com / identity          │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Trust boundary.** Everything left of the MCP server is the user's own agent with the user's
own shell access — we do not sandbox the agent itself. The boundary we *do* enforce is the MCP
tool surface: reads are free, **writes require confirmation**, and the swf bearer token is used
server-side only and never returned to the agent.

---

## 3. Backend design

New module `src-tauri/src/agent/` plus `src-tauri/src/commands/agent.rs`, registered in
`generate_handler!` (`src-tauri/src/lib.rs`), mirroring how `commands::easel::*` and the swarm
supervisor are wired.

### 3.1 PTY supervisor
- Use a PTY (e.g. `portable-pty`) rather than plain `Stdio::piped()` — interactive TUIs need a
  tty. This generalizes `supervisor/swarm.rs`, which today spawns a subprocess and streams
  `BufReader.lines()`; here we pump raw master bytes both ways.
- State: `AppState.agent : Arc<Mutex<Option<AgentSession>>>` holding the child handle, PTY
  master writer, and the chosen backend. One session at a time for v0.1.
- Commands: `agent_detect()` → which backends are installed; `agent_spawn({backend})`;
  `agent_write({bytes})`; `agent_resize({cols, rows})`; `agent_kill()`.
- Stream: a tokio task reads the PTY master and `app.emit("agent://pty-data", bytes)`; on exit
  `app.emit("agent://status", { state: "idle", exitCode })`.

### 3.2 Binary detection & env hygiene
- Reuse the `resolve_agent_binary` strategy from `swarm.rs`: check an env override, `HOME`-local
  installs (`~/.local/bin`, npm/bun global bins), the Tauri resource dir, then `PATH`.
- Spawn with a clean environment (`env_clear()` + minimal `PATH`/`HOME`), as the swarm does, so
  the agent runs deterministically and we control which MCP config it loads.

### 3.3 Per-backend MCP wiring (written at launch)
- Generate a throwaway profile/config dir per session and point the CLI at it, so we don't mutate
  the user's real `~/.claude.json` / Codex config:
  - **Claude Code:** launch with `--mcp-config <file>` (or `--strict-mcp-config`) naming our
    server; optionally `--add-dir`/`--permission-mode` to scope it.
  - **Codex:** write a config TOML with an `[mcp_servers.shape_rotator]` entry and pass it via the
    CLI's `--config`/profile flag.
- The MCP server itself is started by the app (see §5) and addressed over stdio or a loopback
  port; the per-backend config just tells the CLI how to reach it.

---

## 4. Renderer integration

Follow the existing easel/atlas app-view contract (`apps/os/src/renderer/boot.js`):

1. Add `"agent"` to the `APPS_VIEWS` set (boot.js ~line 1479).
2. `apps/os/src/index.html`: add an `#apps-grid-list` button `data-app-key="agent"` (+ icon) and a
   paired `<div id="agent-stage" class="agent-stage"></div>`.
3. New module `apps/os/src/renderer/agent.js` exporting `mount(stage)`, `setActive(bool)`,
   `notifyDataChanged()` — same lifecycle as `easel.js`. On `mount`, build an xterm.js terminal +
   `@xterm/addon-fit`; on `setActive(false)`, stop reading (do not kill the session).
4. Wire mount in `applyActiveTab()` (boot.js ~1524–1558) the way Easel is wired.
5. `apps/os/src/api-shim.js`: expose `window.api.agent = { detect, spawn, write, resize, kill,
   onPtyData(cb), onStatus(cb) }`, bridging to the Tauri commands/events from §3.
6. Bundle xterm.js + addon-fit (new dep in `apps/os/package.json`). Wire `ResizeObserver` →
   `fit()` → `agent_resize` so the PTY tracks the pane size.

---

## 5. MCP tool surface

The in-app MCP server (`src-tauri/src/agent/mcp.rs`) exposes a small, stable tool set. Reads map
onto data the renderer already loads; writes reuse the existing edit/PR flows and are confirmation-gated.

| Tool | Mode | Backing source |
|------|------|----------------|
| `cohort_search({query, kind?})` | read | cohort-surface.json / `srfg:cohort_surface_v1` |
| `cohort_get_record({record_id})` | read | cohort surface (people/teams/clusters/…) |
| `sync_manifest()` | read | swf-node `GET /sync/manifest` (bearer, server-side) |
| `sync_get_record({id})` | read | swf-node `GET /sync/record/<id>` |
| `github_user({handle})` | read | `gh-user.js` path / `api.github.com/users/<handle>` |
| `identity_whoami()` | read | `srwk:identity_v1` |
| `prefs_get({key?})` | read | prefs file |
| `open_pr_draft({record_id, markdown})` | **write — confirm** | `gh-fork.js` fork→PR flow |
| `sync_push({record_id, envelope})` | **write — confirm** | swf-node `POST /sync/local_record` |

Rules: reads return JSON façades, never raw secrets. The swf bearer is injected by the server and
never surfaced to the agent. Every write tool blocks on an in-app confirmation dialog before it
touches GitHub or swf-node; deny ⇒ the tool returns an error the agent can read.

---

## 6. Security & permissions

- **The agent is trusted as the user.** It runs the user's binary with the user's shell access and
  credentials. We don't sandbox it; we scope only the MCP data tools.
- **Writes are explicit.** `open_pr_draft` / `sync_push` always require a confirmation surface in
  the app. Default posture is read-only.
- **Secret hygiene.** The swf agent token is used inside the MCP server only; it is never written
  into the MCP config we hand the CLI, never returned by a tool, and never echoed to the terminal.
- **Throwaway config.** We never edit the user's real `~/.claude.json` / Codex config; per-session
  config lives in a temp dir and is discarded on exit.
- **GitHub rate limits.** Reads stay unauthenticated (60/hr/IP) unless the user supplies a token;
  note this as a known limit rather than persisting a token by default.

---

## 7. Phased plan

- **Phase A — tab scaffold + PTY echo.** Add the `agent` app view, xterm.js pane, and a backend PTY
  that runs a trivial shell to prove bidirectional streaming + resize.
- **Phase B — spawn the real CLI.** `agent_detect` + `agent_spawn` launch the detected
  `claude`/`codex` in the PTY with clean env. No data access yet.
- **Phase C — MCP server, read tools.** Stand up `agent/mcp.rs` with `cohort_*`, `sync_*`,
  `github_user`, `identity_whoami`, `prefs_get`.
- **Phase D — wire MCP per backend.** Generate per-backend throwaway config so the spawned CLI sees
  our server as `shape_rotator`.
- **Phase E — write tools.** `open_pr_draft` / `sync_push` behind a confirmation dialog, reusing
  `gh-fork.js` and the swf-node write endpoint.
- **Phase F — polish.** Theming to match the OS shell, fit/resize robustness, optional session
  persistence and backend picker.

### Testing
Phase A/B: launch the app, open the agent tab, confirm the real TUI renders and accepts input,
and that the pane resizes the PTY. Phase C/D: from inside the agent, call each MCP tool and diff
its result against the same data in the cohort tab / swf-node. Phase E: drive a PR-draft and a
sync push and confirm both block on the dialog and no-op on deny.

---

## 8. Open questions / resolved decisions

1. **Backend selection.** *Resolved:* auto-detect installed binaries; if both exist, the tab shows
   a one-time picker. Persist the last choice in prefs.
2. **MCP transport.** *Open:* stdio (simplest, one server per session) vs a single loopback HTTP
   server shared across sessions. Lean stdio for v0.1.
3. **Session persistence.** *Open:* keep the PTY alive across tab switches (yes) vs across app
   restarts (defer). v0.1 keeps it alive while the app runs; killed on quit.
4. **Multi-session.** *Resolved:* single session for v0.1; the state shape (`Option<AgentSession>`)
   leaves room to grow to a map later.
5. **Working directory.** *Open:* what cwd the agent starts in (a scratch dir vs the repo). Default
   to a per-session scratch dir under `userData/` to avoid surprising filesystem writes.
