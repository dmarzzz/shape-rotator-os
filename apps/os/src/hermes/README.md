# Ask Cohort (Hermes) — standalone brain component

A local-first "connector" that helps a cohort member **find people and learn how
to engage them**, grounded on the cohort-public surface and the member's own
"shape". It runs entirely on the **user's own** LLM — their `ollama` (local), or
their `codex` / `claude` CLI subscription. Nothing is stored or sent to our
servers; the chat is not persisted.

This folder is **self-contained and swappable**. To replace the brain, swap this
folder and keep the two integration calls below — the IPC channel names and the
window contract are the only coupling to the host app.

## Files

| File | Process | Role |
|------|---------|------|
| `integration.js` | main | **The only integration point.** `register({ app, ipcMain, BrowserWindow })` + `menuItem()` + `createWindow()`. |
| `engine.js` | main | Runs a prompt through the user's own `codex`/`claude` CLI. Privacy gate + provider-key stripping live here. Pure Node (unit-testable). |
| `shape-scanner.js` | main | Builds the user's "shape" from public GitHub + local Codex session metadata. Pure Node. |
| `preload.js` | preload | Context-isolated bridge exposing only `window.api.tina` + `window.api.shape`. |
| `index.html` / `app.js` | renderer | The chat UI: engine selector, in-chat onboarding, find/engage prompt, Ollama streaming. |

## Wiring it into a host (Electron main)

```js
const hermes = require("./src/hermes/integration");

// 1. Register the brain's IPC once at startup:
hermes.register({ app, ipcMain, BrowserWindow });

// 2. Put the menu item under your Tools menu (or call hermes.createWindow() from a button):
{ label: "Tools", submenu: [ hermes.menuItem() ] }
```

The window uses **this folder's** `preload.js`, so the host's own preload does
not need to expose anything for the brain.

## Contract (the only coupling)

**IPC channels** (main ⇄ renderer, via `preload.js`):

- `tina:backends` → `{ codex?: {label, available, version}, claude?: {…} }`
- `tina:run` `{ backend, prompt, dataMode, requestId }` → `{ ok, text } | { ok:false, error }`; streams partial stdout on `tina:chunk` `{ requestId, chunk }`
- `tina:stop` → cancels the in-flight run
- `shape:get` → persisted shape or `null`
- `shape:scan` `{ user? }` → freshly built shape (persisted under `userData`)
- `shape:saveSynthesis` `{ synthesis }` → merges a structured shape read

**Grounding input:** the renderer reads `../cohort-surface.json` (the
cohort-public projection the app already ships) and the user's scanned shape.

## Privacy model (enforced by construction)

- `engine.js` has **no** network/Supabase client — it cannot exfiltrate.
- **Data-mode gate** (`assertBackendAllowed`): only `public` grounding may reach
  a remote backend (codex/claude). Private/transcript data must stay on a local
  model (Ollama). The renderer only sends the public cohort surface to remote
  backends; private Codex detail is included only for Ollama.
- **Provider-key stripping** (`spawnEnv`): `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY(_PATH)` are
  removed from the spawned environment so a backend always rides the user's own
  on-disk login (`~/.claude`, `~/.codex`) — billed to **their** subscription,
  never a key inherited from our process. Opt back in with
  `SRWK_HERMES_USE_ENV_KEYS=1`.

## Setup (what a member needs)

One of:

- **Claude** — `npm i -g @anthropic-ai/claude-code`, then run `claude` and sign in.
- **Codex** — `npm i -g @openai/codex`, then `codex login`.
- **Ollama** — install from ollama.com, then `ollama pull hermes3:8b` (fully offline).

The connect screen shows live status and these steps; once one engine is
connected the chat box onboards the member from there.
