# swarm search — PRD (draft)

> Status: speccing. Not started. Lock decisions in this file before any
> code lands.

## the ask

The search app already has a swarm runner — an Electron-supervised
`research-agent` Python subprocess (`dmarzzz/research-swarm`) with a
modal panel that streams plain-text trace lines. It works, but it's a
CLI in a box. The user wants:

1. A swarm-search **theatre** — its own visual register that shows what
   the agents are doing while they're doing it. Different feel from the
   atlas. Fun and engaging but not costume.
2. Pages the swarm fetches show up in the **atlas** as normal towns,
   the same way any other search result does. The atlas does not get a
   special swarm view — it just naturally grows.
3. A useful artifact at the end: the pulled pages (already on the
   atlas) **plus** a synthesized answer.
4. Three tempo presets per run: sprint, standard, expedition.

Backed by `dmarzzz/research-swarm`. If the agent needs new
capabilities (e.g. emit structured progress events the UI can render),
we PR them upstream.

---

## what exists today

### atlas (apps/os/src/renderer/atlas.js, ~5.9k LoC)
- Paper-cream wall map. Peers = countries (Fibonacci-spiral centroids).
- Pages = towns placed deterministically per-page.
- Cross-peer co-fetches = caravan arcs.
- One slow surveyor drifts. Reads `window.srwk.{nodes, edges, peers}`.
- Designed to be projected and photographable.

### search-view
- SearXNG-style single-query UI. Policy / egress / top_k controls.
- "ask my agent" button opens the swarm panel.

### swarm panel (apps/os/src/index.html:228, boot.js:8819)
- Modal overlay (NOT in the atlas). Backdrop + card.
- Query input · model select (anthropic/* · ollama/*) · parallel
  toggle · start/stop.
- Live trace area is a plain-text scrolling log.
- Settings sub-modal: anthropic key (encrypted in safeStorage), ollama
  base URL.

### swarm IPC (apps/os/main.js:317 · apps/os/swarm-node.js)
- `fg:swarm:status` / `start` / `stop` / `config:get` / `config:set`.
- Streams `fg:swarm:output { requestId, stream, line }` per stdout/err
  line. `fg:swarm:status-changed { state: running|idle, ... }`.
- Supervises a single `research-agent` child at a time.
- Resolves binary from `RESEARCH_AGENT_BIN` env or
  `~/research-swarm/.venv/bin/research-agent` /
  `~/shape-rotator-field-kit/research-swarm/.venv/bin/research-agent`.
- Passes `--parallel` and `--workers N`. CWD is the agent repo so it
  picks up its own `.env`.

### research-swarm (`dmarzzz/research-swarm`)
- DSPy ReAct agent. Tools: `local_search`, `web_search` (DDG +
  SearXNG), `arxiv_search` / `arxiv_fetch_paper`,
  `semantic_scholar_search`, `github_search`, `nitter_search`,
  `fetch_url`, `fetch_urls_parallel`, `extract_links`,
  `verify_arxiv_citations`, `expanded_search`.
- Two modes: single ReAct loop, or `--parallel` (STORM fan-out — split
  into 3–5 sub-questions, one ReAct loop each, then merge).
- Optional critic pass; `--no-critique` to skip.
- **Writes to `~/world_knowledge/web/<host>/<date>-<slug>.md` and
  updates `~/world_knowledge/index.db` — the same archive swf-node
  reads.** Trace JSON to `runs/YYYYMMDD-HHMMSS-<slug>.json` with every
  tool call, output sizes, synthesis, sources, critique.

### swf-node
- Spawned by SROS at `127.0.0.1:7777`. Serves `/graph`, `/pages`, etc.
- Stores pages in `~/world_knowledge/index.db` (`pages` + `pages_meta`
  + `search_results`).
- Atlas plots `pages` rows. (See [project_search_index_fix.md] in
  user memory — atlas correctly switched from `search_results` to
  `pages` in May 2026.)

---

## the gap

- Swarm UI is a text log over the search tab. No theatre, no atlas
  presence, no sense of *multiple agents at work*.
- Today's `--parallel` is opaque — workers spawn but the user sees an
  interleaved stdout stream with no per-worker channel.
- It's unclear whether research-swarm's fetched pages end up in
  swf-node's `pages` table or only in the FTS5 index. (See open
  questions.)
- No tempo dial. `--parallel` is a binary; there's no "expedition
  mode" for the multi-week event.
- The synthesis output is buried at the end of the trace log instead
  of becoming a real artifact.

---

## decisions locked (from clarification round)

1. **Engine.** Use `dmarzzz/research-swarm` as the agent core. PR
   upstream changes if needed (esp. structured event stream).
2. **Atlas integration is implicit.** Every page the swarm fetches
   through any tool joins the atlas as a normal town. No special
   styling — the atlas is what the atlas is. (Verification + plumbing
   work required; see Architecture.)
3. **The swarm theatre is its own surface.** Visually distinct from
   the atlas; shows progress and per-agent activity in real time.
4. **Artifact = pages on the atlas + a synthesized answer.** Both
   surfaced where the user can find them after the run ends.
5. **Tempo dial.** Sprint / Standard / Expedition selectable per run.
   PRD must support all three.

---

## concept

Two surfaces, one run:

```
           ┌─────────────────────────────────────────┐
           │   SWARM THEATRE  (its own visual)       │
           │   modal / panel / pinned overlay        │
           │                                         │
           │   • shows what each agent is doing      │
           │   • live, kinetic, "fun and engaging"   │
           │   • aesthetic-aligned (not space        │
           │     cosplay; nods to membrane shader)   │
           │                                         │
           │   ends in a SYNTHESIS ARTIFACT card     │
           └─────────────────────────────────────────┘

                          │  emits during run
                          ▼
           ┌─────────────────────────────────────────┐
           │   ATLAS  (unchanged aesthetically)      │
           │                                         │
           │   • pages fetched by the swarm appear   │
           │     as normal towns in your country     │
           │   • caravans form to other countries    │
           │     when a swarm page co-occurs there   │
           │   • atlas is the persistent record;     │
           │     theatre is the performance          │
           └─────────────────────────────────────────┘
```

Theatre is ephemeral (the performance). Atlas is permanent (the
artifact). Synthesis card is the bridge.

---

## ux flow

### entry
Two entry points to the same swarm theatre:
- Existing "ask my agent" button in `#search-view` (already wired —
  evolve, don't replace).
- A second entry on the atlas: a small `surveyor's commission` button
  on the cartouche. Clicking it pre-seeds the swarm with "what would
  you map next, given what we already have?" or the user's typed
  question.

### tempo dial
Replace the binary `parallel` checkbox with a three-state segmented
control:

| preset | wall time | workers | depth | critic | atlas yield (target) |
|---|---|---|---|---|---|
| **sprint** | 30–90 sec | 1 (single ReAct) | shallow (max_iters ≈ 8) | off by default | 3–10 pages |
| **standard** | 3–10 min | 3 parallel | normal (max_iters ≈ 14) | on | 15–40 pages |
| **expedition** | hours / overnight | 5 parallel + rolling refresh | deep (max_iters ≈ 28, follow_links) | on, twice | 80–300 pages, ambient growth |

Sprint is intended to feel like a search. Expedition is intended for
the wall during the cohort event — kicked off and forgotten until the
user comes back.

### during a run
- Swarm theatre opens. Backdrop dims behind it.
- The user can **dismiss the theatre at any time** — the run keeps
  going in the background. A small "swarm in progress" tab indicator
  appears on the atlas/search tabs. Re-clicking it re-opens the
  theatre at the live state.
- For **expedition**, the theatre auto-minimizes after 30 sec idle of
  cursor movement into a thin atlas-friendly status strip
  ("expedition · 47 pages · 23m elapsed") so the wall projection
  stays calm and the atlas stays the dominant artifact.

### at completion
- Theatre runs its final animation (synthesis card materializes).
- Card pins to the atlas legend area as a "field journal entry" with:
  - The question.
  - The synthesis (markdown, scrollable).
  - Inline citation links — clicking a citation pulses the
    corresponding town on the atlas (reuses existing `pulseNode`).
  - Counts: pages added, sub-questions explored, total time, model.
  - "view trace" — opens the raw research-swarm trace JSON (see
    Useful Artifact).
  - "share with cohort" toggle (default off; see Privacy).
- The user can close the card; it persists in a `swarm:history`
  drawer on the atlas (a new affordance — small scroll-icon in the
  atlas legend).

---

## visual concept

User intent (paraphrased): *"show the search going on. agents
represented. the public internet represented. every time a query
fires, draw a diagram that hits the public internet."*

So the theatre's job is **literal**: render the act of the swarm
striking the outside world, in real time, recognizably. Not abstract.

### the stage — "agents vs. the outside"

Two zones with a wire between them. Reuses the existing `membrane/`
shader infrastructure (`pressureMaterial.js`, `blob.js`, `noise.js`,
`scene.js`) so it's not a fourth visual language — the dividing wire
between zones is a membrane that deforms on traffic.

```
┌─────────────── THE PUBLIC INTERNET ───────────────┐
│                                                   │
│  ◯ ddg     ◯ searxng    ◯ arxiv    ◯ github      │
│      ◯ nitter     ◯ planetary-mix.org             │
│      ◯ wikipedia       ◯ <ad-hoc host>            │
│                                                   │
└──╳────╲────╲────╳───╳──────────────────╳──────────┘
    ↑    ↑    ↓    ↑   ↓                  ↑
    │    │    │    │   │   ← packets in flight; faint
    │    │    │    │   │     trails persist as a run sigil
   ┌┴────┴────┴┐  ┌┴───┴┐ ┌──────────────┐
   │  agent α   │  │ β   │ │  agent γ     │
   │ "design of │  │"impl│ │ "ops of X"   │
   │     X"     │  │ of X│ │              │
   │ 🟢 fetching│  │⚪idle│ │ 🟢 searching │
   └─────┬──────┘  └──┬──┘ └────┬─────────┘
         └─── pages fall through ────┘
                         │
                         ▼  drop into the atlas indicator
```

#### top zone — the public internet
- Rendered as **distinct destinations**, not a cloud. Each is a small
  node with a glyph/label:
  - `ddg`, `searxng`, `arxiv`, `github`, `semanticscholar`, `nitter`
    — fixed positions (sigil-like, deterministic).
  - For `fetch_url(host=...)`, the host appears as an **ad-hoc planet**
    placed by hash of the hostname. Falls off the stage if not
    touched for a while.
- Destinations have an idle state (dim glyph) and a **hot state**
  (pulsing, brighter ring) while a query against them is in flight.
- Count badge on each destination — how many times this run has hit
  it.

#### bottom zone — the agents
- One card per sub-question. Card shows: agent label (e.g. `α`),
  sub-question text (truncated), live status (idle / searching /
  fetching / synthesizing), tool-call counter, last tool name.
- For sprint mode (single ReAct), just one agent card centered.
- For expedition (up to ~8 sub-questions), agents arrange in a row;
  card density compresses.

#### the wire — packets in flight
- `tool_call_started` → a **packet glyph** leaves the agent card,
  arcs upward to the destination. Glyph shape = tool family:
  - `◯` = search (web_search / arxiv_search / github_search / etc.)
  - `▢` = fetch (fetch_url / fetch_urls_parallel)
  - `△` = extract / verify / synthesis
- Trail persists faintly behind the packet (~30% opacity, lingers
  for the run).
- Destination pulses on arrival.
- `tool_call_completed` → return packet leaves destination, arcs
  back. Size proportional to result bytes (log scale). Color of
  trail = green/normal, red/failure, white-double/cache hit.
- `page_fetched` → return packet does not stop at the agent; it
  continues downward through the agent card and **falls off the
  stage** into the atlas tab indicator. Atlas pip flashes (reuse
  existing `pulseNode`). This is the visible "pages flow into the
  atlas" moment the user asked for.

#### the run sigil
- Every packet leaves a trail. By the end of a run, the accumulated
  trails form a **dense network sigil** — the wiring of where the
  swarm actually went.
- The sigil is rendered as a small bitmap stamp on the synthesis
  card and saved alongside the trace JSON. Each run gets a unique
  sigil. (Lightweight; later we could `git`-ify or trade them.)

#### completion animation
- When the synthesizer fires, the agent cards converge inward, the
  destinations dim, the wires resolve into a single drawn boundary
  around the synthesis card. The sigil sits in the card corner as
  the run's signature.

### why this works for the ask
- **Literal.** The user can point at the screen and say "look,
  agent β is hitting arXiv right now." No reading-between-the-lines.
- **The public internet has a face.** It's not a black box — it's
  ddg, arxiv, github, the specific hosts the swarm chose to read.
- **Engaging.** Constant kinetic motion during the run, but the
  motion *means something* (each packet = a real tool call).
- **Atlas connection is visible.** Pages literally fall off the
  bottom of the stage into the atlas.
- **Aesthetic blend.** Cypherpunk packet-trace × milady delicate
  trails × shape-rotator deterministic-glyph destinations. Not
  space cosplay (no rockets, no rovers, no "AI agents" mascots).
- **Photographable.** Mid-run states are dense network drawings; the
  finished sigil is a clean composition.

### sound (optional, off by default)
- Tiny tonal pings when a packet leaves an agent (one tone per tool
  family). Mute by default; toggle in theatre settings.

### alternates considered & rejected
- **Mandala drawing itself** (earlier draft) — too abstract; user
  wanted to *see the search*, not a metaphor for it.
- **Glass kiln / loom** — same issue; aesthetic but illegible.
- **Terrarium of pixel agents** — anthropomorphizes too far; risks
  the cute-mascot register the user has rejected.

---

## architecture

```
  user
   │  start({question, tempo})
   ▼
  ┌──────────────────────────────────────────────┐
  │ swarm-panel (renderer)                       │
  │   wireSwarmPanel() — boot.js:8819            │
  │   evolves into wireSwarmTheatre()            │
  └──────────────┬───────────────────────────────┘
                 │  ipc fg:swarm:start
                 ▼
  ┌──────────────────────────────────────────────┐
  │ main.js + swarm-node.js                      │
  │   spawn research-agent --emit-events ndjson  │
  │   (new flag — see "research-swarm changes")  │
  └──────────────┬───────────────────────────────┘
                 │  stdout: structured events
                 ▼
  ┌──────────────────────────────────────────────┐
  │ research-agent                               │
  │   • ReAct loop(s)                            │
  │   • every tool call → fetches pages          │
  │       ↓                                      │
  │     ~/world_knowledge/web/<host>/...md       │
  │     ~/world_knowledge/index.db (fts5)        │
  │   • emits ndjson events on stdout            │
  └──────────────┬───────────────────────────────┘
                 │  same archive
                 ▼
  ┌──────────────────────────────────────────────┐
  │ swf-node @ 127.0.0.1:7777                    │
  │   /pages picks up new rows                   │
  │   (verification — see open question Q1)      │
  └──────────────┬───────────────────────────────┘
                 │  sync-client polling / sse
                 ▼
  ┌──────────────────────────────────────────────┐
  │ atlas (renderer) — atlas.js                  │
  │   notifyDataChanged() → new towns appear     │
  │   pulseNode() on swarm-just-fetched pages    │
  └──────────────────────────────────────────────┘
```

### IPC additions
Today: `fg:swarm:output { stream, line }` (plain text).

Add:
- `fg:swarm:event { requestId, ts, kind, ...payload }` — structured.
  Kinds: `run_started`, `subquestion_planned`, `tool_call_started`,
  `tool_call_completed`, `page_fetched { url, host, page_id, bytes }`,
  `subquestion_completed`, `critic_started`, `critic_completed`,
  `run_completed { synthesis_md, sources[], trace_path }`,
  `run_failed { reason }`.
- Keep `fg:swarm:output` for raw log → debug panel inside theatre.

### Renderer: theatre module
New module `apps/os/src/renderer/swarm-theatre.js`:
- Owns the mandala canvas (reuse atlas's deterministic-hash placement
  helpers — same module aesthetic).
- Consumes `fg:swarm:event` stream → drives mandala state.
- Exposes `open({ requestId })` / `close()` / `minimize()`.
- On `run_completed`: emits a `srwk:swarm-run-completed` DOM event
  → atlas listens, plays "field journal entry" animation, pins card.

### Renderer: search & atlas hooks
- `search-view` ask-my-agent button keeps working; routes to theatre.
- Atlas gains `cartouche.surveyor-commission` button.
- Atlas gains `swarm:history` drawer (per-run cards, latest 20).
- `boot.js`: the existing `setupSwarmPanel` is split — config UI stays
  modal, runner UI becomes `swarm-theatre`.

---

## research-swarm changes (will need a PR)

To make the theatre work, research-swarm has to emit structured
progress, not just stdout. Concrete proposal:

1. **`--emit-events FORMAT`** flag (`ndjson` first). When set, emits
   one JSON object per line to stdout (instead of human-readable
   trace), schemaed.
2. **Event schema** mirrors the IPC kinds above. Reuse the existing
   `runs/*.json` trace schema (already imported from swf-node) so the
   wire format is just "stream of trace deltas" rather than a new
   shape.
3. **`--max-iters N`** is already an internal const; expose as a flag
   so SROS can pass `max_iters` per tempo preset.
4. **`--workers N`** already exists; keep.
5. **`--follow-links` / `--no-follow-links`** to gate `extract_links`
   for sprint mode (sprint should not chase follow-up links — it's
   "answer fast").
6. **`--budget-pages N`** (soft cap) — sprint=10, standard=40,
   expedition=300. Agent stops invoking fetch tools when reached,
   continues to synthesis on what it has.
7. (nice-to-have) **stream the synthesis** progressively in the final
   event so the theatre can render it as it's written.

This is one PR to research-swarm. Net-additive flags, doesn't break
the CLI for current users.

---

## useful artifact

Three pieces, all kept:

1. **Pages on the atlas.** Implicit. The atlas grows during the run
   and stays grown. Already half-true (archive is shared); needs
   verification that `pages_meta` is written, not just the FTS5
   index.
2. **Synthesis card** pinned to atlas legend area + accessible from
   `swarm:history` drawer.
3. **Trace JSON** — research-swarm already writes one per run. Surface
   it via "view trace" button on the synthesis card. Opens a
   read-only viewer (lightweight tree view of the events). This is
   also what `content-pipeline` consumes (per [project_content_pipeline]
   in memory), so the user can immediately pipe a swarm run into a
   blog/thread/video.

---

## cohort + privacy

Current behavior (from memory + cohort-source.js): public-egress
searches default to `user_fetched + friends` share scope. The user has
explicitly approved this as the desired default for SROS.

Apply the same model to swarm:
- Each `page_fetched` event from research-swarm tags pages as `swarm`
  + `user_fetched`. Defaults to `friends` share scope, same as
  regular public-egress search.
- Synthesis card has a "share with cohort" toggle (default OFF for
  now — a swarm synthesis is a more curated artifact than a raw page;
  cohort-broadcast is a v2 decision).
- Surveys (other cohort members can see "X is running an expedition
  on Y") — defer to v2.

Reuse existing egress confirmation flow — if the user has not opted
into public egress in search-view, the swarm refuses tools that use
public networks (`web_search`, `fetch_url` to non-local hosts, etc.)
and falls back to `local_search` only. The user gets a banner
explaining.

---

## rollout / mvp slices

Order by smallest shippable. Each slice should be PR-sized.

### slice 1 — route the swarm through swf-node (two coordinated PRs)

Today: research-swarm goes direct — `web_search` calls DDG (and
SearXNG only if `SEARXNG_URL` is set, which SROS doesn't set);
`fetch_url` uses raw urllib + trafilatura + Jina, writing pages
straight to `~/world_knowledge/web/`. swf-node never sees the
traffic, so atlas growth from swarm runs is at best accidental.

Target: all swarm search and fetch route through swf-node. swf-node
becomes the single ingest point — it owns the archive write, the
privacy/share-scope tagging, and the atlas-visible `pages` row.

swf-node already exposes the needed endpoints
(`apps/searxng-wth-frnds/src/swf/peer_server.py`):
- `POST /web_search` — SPEC v0.3 envelope
- `POST /search` and `POST /local_search`
- `POST /fetch` and `POST /fetch_url` (deprecated alias) — bearer-token
- `POST /fetch/batch` and `POST /fetch_urls` (deprecated alias)
- `POST /metasearch` — legacy fan-out, kept literally "for the
  research-agent until it migrates" (its own code comment)

Two PRs, both small + additive:

**PR-A · research-swarm: `RA_BACKEND=swf-node`**

- New env vars: `RA_BACKEND` (`direct` default, `swf-node` enables
  routing), `SWF_NODE_URL` (e.g. `http://127.0.0.1:7777`),
  `SWF_NODE_TOKEN` (bearer for `/fetch*`).
- When `RA_BACKEND=swf-node`:
  - `web/providers.py:_provider_searxng` (or a sibling
    `_provider_swf`) calls `POST /web_search` against `SWF_NODE_URL`,
    bypassing DDG entirely.
  - `web/fetch.py:fetch_url` calls `POST /fetch` with bearer token
    instead of urllib+trafilatura. Returns the same `(text, extractor)`
    shape so callers don't change.
  - `web/fetch.py:fetch_urls_parallel` calls `POST /fetch/batch`.
  - Local archive write is skipped on this path — swf-node owns it.
- Default path (`RA_BACKEND=direct`) is unchanged. Non-SROS users
  keep DDG+trafilatura+Jina.
- Tests: unit-test each backend choice with a fake swf-node fixture.

**PR-B · SROS: inject SWF env into swarm-node.js**

- `apps/os/swarm-node.js:start()` builds the spawn env. Add:
  ```js
  RA_BACKEND: "swf-node",
  SWF_NODE_URL: process.env.SWF_NODE_URL || "http://127.0.0.1:7777",
  SWF_NODE_TOKEN: swfNode.getAgentToken() || "",
  ```
  (Token comes from the existing `fg:swf-agent-token` plumbing —
  `main.js:315`. It's the same bearer the renderer already uses.)
- No UI changes.

**Acceptance**: launch SROS → swarm → run any web-touching query →
within seconds, a new town appears in the atlas tagged
`user_fetched` + `friends` share scope, just like a regular search.
No theatre yet; this is invisible-plumbing slice.

### slice 2 — research-swarm event stream
- PR `--emit-events ndjson` to research-swarm.
- Update `swarm-node.js` to parse events and emit structured IPC.
- Plain-text trace falls back to a "raw log" panel inside the
  current modal (no theatre yet).

### slice 3 — tempo dial
- Replace `parallel` checkbox with sprint/standard/expedition
  control.
- Pass `--max-iters`, `--workers`, `--budget-pages`,
  `--follow-links` per preset.
- Still using current modal; no theatre yet.

### slice 4 — theatre v1 (mandala)
- Build `swarm-theatre.js`. Mandala drawing-itself.
- Synthesis card pinned to atlas legend.
- Minimize / re-open behavior.

### slice 5 — atlas integration polish
- `swarm:history` drawer with last N runs.
- Citation-pulse on town from synthesis-card link.
- Surveyor-commission button on atlas cartouche.

### slice 6 — expedition wall-mode
- Auto-minimize after 30s idle.
- Atlas-edge status strip.
- Memory + rate-limit handling for long runs.

### slice 7 — cohort share (v2)
- Synthesis cards optionally publish to cohort feed.
- "X is on expedition" presence signal.

---

## open questions

These need answers before we build past slice 1.

**Q1. (resolved.)** ~~Does research-swarm's archive actually land
in swf-node's `pages` table?~~ Answered by inspecting both repos:
research-swarm today writes its own FTS5 schema directly to
`~/world_knowledge/index.db`, bypassing swf-node entirely. SROS
also fails to set `SEARXNG_URL`, so even the search path skips
swf-node. **Slice 1 now routes all swarm traffic THROUGH swf-node
(see two-PR plan in Rollout) instead of trying to bridge two
parallel writers to the same archive — single-ingestion-point is
the correct architecture and matches the user's intent.**

**Q2. Where does the synthesis card live?**
- (a) Inline on the atlas legend (cartouche-adjacent). Persistent.
- (b) Floating card on theatre close, dismissable. History via
  drawer.
- (c) New tab "Field Journal" with run history.
PRD assumes (b) + drawer for history. Decide.

**Q3. Theatre placement.**
- (a) Modal overlay over atlas (current swarm-panel pattern).
- (b) Right-side pinned panel — atlas stays visible behind/beside it.
- (c) Bottom-third strip (lets the atlas stay dominant — best for
  wall projection).
PRD assumes (a) for sprint/standard and (c) auto-collapse for
expedition. Decide.

**Q4. Concurrent runs.**
- Today: at most one `research-agent` child at a time
  (`swarm-already-running` error).
- For expedition + ad-hoc sprint: do we allow N concurrent runs? If
  yes, how does the theatre show them? (Multiple mandalas? Tabs?)
PRD assumes single-run for v1, multi-run deferred.

**Q5. Expedition pacing / budget.**
- Rate-limit story for SearXNG / arxiv / DDG over multi-hour runs.
- Page-budget gates this somewhat; need a wall-time gate too.
- Cost gating if model is Anthropic — should the theatre show a
  running spend estimate for hosted models?

**Q6. Visual concept lock.**
- Mandala (A), kiln (B), or terrarium (C)? Or something else.
- PRD recommends A. Awaiting confirmation before any renderer work.

**Q7. Sound.**
- Default off. Confirm.

**Q8. Privacy default for synthesis sharing.**
- Default OFF feels conservative. Cohort-public default is what the
  user already wanted for raw searches. Should synthesis be the
  same? Decide before slice 7.

---

## out of scope (v1)

- Multi-user swarm collaboration ("invite cohort to my expedition").
- Tool-by-tool live previews (e.g. showing rendered markdown of a
  page as it's fetched).
- Custom tool registration UI inside the theatre. (Edit
  `research-swarm/agent.py` like today.)
- Voice / wake-word swarm trigger.
- Persistence of mid-run state across SROS restarts. (Run dies with
  the app.)

---

## references

- `apps/os/src/renderer/atlas.js` — atlas implementation.
- `apps/os/src/index.html:228` — current swarm panel markup.
- `apps/os/src/renderer/boot.js:8819` — `wireSwarmPanel`.
- `apps/os/swarm-node.js` — subprocess supervisor.
- `apps/os/main.js:317` — swarm IPC handlers + config persistence.
- `dmarzzz/research-swarm` — agent core. README documents tool zoo
  and trace format.
- `dmarzzz/searxng-wth-frnds` — swf-node daemon and shared archive.
- `~/world_knowledge/` — shared markdown archive + FTS5 index.
