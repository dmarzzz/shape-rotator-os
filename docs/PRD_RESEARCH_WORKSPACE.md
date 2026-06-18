# PRD — Research Workspace ("Centaur Research")

> A local-first, chat-driven research workspace for the Shape Rotator cohort.
> A faithful **slop fork** of [orchestra-research.com](https://orchestra-research.com):
> we reproduce the *experience and the system model* — a research copilot that
> turns a question into a living knowledge graph — without touching their APIs,
> backend, or credits. Everything runs in the browser.

- **Owner:** dmarzzz
- **Surface:** `apps/web/research/` → served at `/research` (Vercel, static)
- **Status:** v0 — ship the loop, then deepen
- **Aesthetic target:** clean, light, rounded SaaS (Orchestra's look), not the
  brutalist mono of `/workspace`. Reuses the repo font stack
  (Space Grotesk + JetBrains Mono).

---

## 1. Why

Orchestra Research is the cleanest expression of a pattern we want for the
cohort: you ask a research question, an AI *copilot* decomposes it into a
structured, navigable **research canvas** (a node graph of questions, scope,
theory, literature, baselines, methods), keeps a **content outline** in sync,
spawns **agents** to do work, logs a **timeline**, tracks **experiments**, and
collects **files** and **skills**. It feels like a research operating system.

We want the same thing, cohort-flavored and local-first. No accounts, no
credits, no server round-trips, no vendor lock. A single static page that holds
its own state in `localStorage` and runs a **local copilot engine** under the
hood. It should feel alive and agentic even with zero network.

> **Slop-fork principle:** match observable behavior and the system model.
> Do not call Orchestra. Do not require any external API. The copilot ships a
> deterministic local engine; an optional pluggable LLM strategy is a hook, not
> a dependency.

## 2. What we are cloning (from the screenshots)

The reference is a two-pane project view:

**Left — Chat / research copilot**
- Project header: `New Research Project`, editable title, Back.
- A chat thread (`New chat`) of user + copilot turns.
- Copilot **progress steps** mid-turn: `✓ Checking project`, `⟳ Deep research "…"`.
- An **agent result card** (e.g. *Literature Review*) with a summary blurb, a
  spinner while running, and **Agree / Disagree** feedback buttons.
- A **⚡ Suggested directions** block: 2–4 cards, each a title + rationale +
  one action chip (`Deepen: …` / `Explore: …`).
- Composer at the bottom: attach, text input ("Ask about your research…"),
  mic, send/stop. While the canvas builds: "Canvas is updating. You can keep
  drafting while it finishes…".

**Right — Workspace tabs**
`Canvas · Content · Agents · Timeline · Experiments · Files · Skills`

- **Canvas** — a zoomable/pannable node graph. Nodes are typed cards
  (`MAIN QUESTION`, `SCOPE`, `THEORY`, `LITERATURE`, `BASELINE`, `METHOD`,
  `METADATA`, `EXPERIMENT`) with a type chip, a status pill
  (`Not Started` / `In Progress` / `Completed`), title, and a one-line body.
  Edges connect parents to children. Controls: `Organize` (auto-layout),
  view filter (`All`), zoom `+ / − / fit`, an "N nodes" counter, empty state
  ("Your Research Canvas is Empty…").
- **Content** — the same graph as a collapsible outline: colored bullet per
  node, indentation by depth, a section count, top-level groups
  (e.g. the main question's children + "Project Principles and Methodology").
- **Agents** — the copilot's worker agents (Literature Review, Baseline
  Builder, Quantizer…) with status, current task, and last output.
- **Timeline** — chronological event log of everything the copilot did.
- **Experiments** — experiment cards (hypothesis, status, metric) e.g.
  "Train CNN baseline on MNIST → 99.1% acc".
- **Files** — generated artifacts (lit_review.md, train.py, results.json).
- **Skills** — the toolbox the copilot can invoke (Deep Research, Write Code,
  Literature Review, Quantize, Critique…), each toggleable.

Left rail (global): project orb, cloud, projects, experiments, tools; bottom:
profile, comments, invites.

## 3. Scope

### v0 (ship now)
- Single project, persisted to `localStorage` (multi-project list is a stretch).
- Chat copilot with the full turn choreography: progress steps → agent card →
  suggested directions. Driven by a **local engine** (no network).
- Live **Canvas** (SVG): typed nodes, status pills, edges, drag, zoom/pan,
  Organize auto-layout, node counter, empty state.
- **Content** outline kept in sync with the canvas.
- **Agents**, **Timeline**, **Experiments**, **Files**, **Skills** tabs, all
  reading the one shared project state and updating as the copilot works.
- Agree/Disagree on agent cards; Deepen/Explore chips that mutate the canvas.
- Reset / new-project control. Everything client-side.

### Out of scope for v0
- Real LLM calls (hook exists, off by default), real web search, collaboration/
  multiplayer, auth, credits/invites economy, file execution, voice STT
  (mic is decorative), mobile-perfect layout.

## 4. The local copilot engine ("the system under the hood")

A deterministic, template + keyword engine that *feels* agentic. Pipeline when a
question is submitted:

1. **Checking project** — quick step, resolves instantly.
2. **Deep research** — a timed "thinking" step (staged, ~cosmetic delays) that
   streams a short plan into the thread.
3. **Decompose** — derive a `MAIN_QUESTION` node from the prompt, then seed
   typed children: `SCOPE`, `THEORY`, `LITERATURE`, `BASELINE`, `METHOD`, plus a
   detached `METADATA` ("Project Principles and Methodology"). Titles/bodies are
   filled from keyword templates seeded by the prompt so two different questions
   yield different-looking graphs.
4. **Literature Review agent card** posts with a summary; flips from spinner →
   done; offers Agree/Disagree.
5. **Suggested directions** — 3 cards, each carrying an action that, when
   clicked, adds/extends nodes (e.g. *Deepen: Write training script* → adds a
   `Files` artifact + flips Baseline to In Progress + logs Timeline).
6. Every mutation writes Timeline events and updates the tab badges/counts.

Engine surface (for the pluggable hook):
```js
window.CopilotEngine = {
  respond(projectState, userText) -> AsyncGenerator<Event>
}
// Events: {type:'step'|'message'|'agentCard'|'suggestions'|'graphPatch'|'timeline'|'done', ...}
```
Default export is the local engine. Swapping in an LLM-backed engine that emits
the same events is a drop-in — but never required and never on by default.

## 5. Data model (localStorage: `srk.research.project`)

```ts
Project {
  id, title, createdAt, updatedAt,
  chat: Message[],
  nodes: Node[],            // canvas + content derive from this
  agents: Agent[],
  timeline: Event[],
  experiments: Experiment[],
  files: FileArtifact[],
  skills: Skill[],
  view: { tab, zoom, pan }
}
Node   { id, type, title, body, status, parentId, x, y }
Message{ id, role:'user'|'copilot', kind:'text'|'steps'|'agentCard'|'suggestions', payload, ts }
Agent  { id, name, status, task, lastOutput }
Event  { id, ts, label, detail }
Experiment { id, title, hypothesis, status, metric }
FileArtifact { id, name, kind, preview }
Skill  { id, name, desc, enabled }
```
`status ∈ {not_started, in_progress, completed}`.
`type ∈ {main_question, scope, theory, literature, baseline, method, metadata, experiment}`.

## 6. UX / visual spec

- Light theme, white canvas, soft `#f7f7fb` panels, 1px `#ececf1` borders,
  12–16px radius, indigo accent `#6d5efc`. Status colors: amber (in progress),
  green (completed), grey (not started). Type chips tinted per type.
- Two-pane split with a draggable gutter (default ~46/54). Tab bar on the right.
- Canvas nodes are rounded cards ~220px wide; smooth pan/zoom; edges are curved
  paths; Organize runs a simple tidy-tree layout.
- Motion: progress steps animate in, agent card spinner, node "pop" on create,
  subtle. No heavy libraries — hand-rolled SVG + CSS. Self-contained single file.

## 7. Success criteria

1. Land on `/research`, type a question, hit send.
2. Within seconds the canvas fills with a connected, typed, status-badged graph;
   Content mirrors it; a Literature Review card and 3 suggested directions appear.
3. Clicking a Deepen/Explore chip visibly extends the graph and logs Timeline.
4. Reload the page → everything persists.
5. Zero network requests required for the core loop.
6. It reads as a beautiful, believable research OS — the screenshots, forked.

## 8. Risks / notes

- **Believability without an LLM:** mitigated by keyword-seeded templates +
  staged timing + real state mutation. It's slop, but coherent slop.
- **One big file** matches repo convention (`/workspace`), keeps Vercel deploy
  trivial (no build step), and avoids a framework. Trade-off: less modular.
- **Nav:** add `/research` to the shared site nav for discoverability; the page
  itself is full-screen and standalone like `/workspace`.

## 9. Rollout

- Build `apps/web/research/index.html`, add `/research` to the shared nav.
- Deploy via existing `npm run deploy:web` (vendor + `vercel deploy --prod`).
- Follow-ups: multi-project switcher, real LLM strategy behind a key, export to
  markdown, share-link.
