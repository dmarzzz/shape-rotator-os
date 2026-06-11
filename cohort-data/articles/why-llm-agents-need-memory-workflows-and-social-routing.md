---
record_id: why-llm-agents-need-memory-workflows-and-social-routing
record_type: article
schema_version: 1
title: "Why LLM agents need memory, workflows, and social routing"
slug: why-llm-agents-need-memory-workflows-and-social-routing
editorial_section: agent infrastructure
audience: cohort
status: draft
content_version: "v0.0.1"
published_at: null
authored_week: w1.5
sources:
  - "Day 1 project intro session notes"
  - "Agents Day 3 project intro session notes"
  - "Dumb Agent Tricks session notes"
  - "Friday session notes with Shaw and Greg"
related_clusters: [agents, agentic-dev-platform]
related_teams: [elizaos, jjhub, contexto, teleport-router, tinycloud]
related_people: [shaw-walters, andrew-miller, sm86, will-cory, hudson, lsdan]
working_angle: "Useful agent work disappears into private sessions, lost context, and brittle long-running tasks, so Shape Rotator should explain why agent workflows need durable memory, social routing, audit trails, and human override."
---

# Why LLM agents need memory, workflows, and social routing

## the claim

Most of the agent work happening in this cohort is invisible. Not because anyone is hiding it, but because the substrate it runs on doesn't preserve it. Agents spin up in terminal tabs, churn through a context window, get rate-limited overnight, lose the thread, and start fresh in the morning with a heartbeat file as their only thread to who they used to be. The work that's actually delivered is the work whose state somebody happened to capture in a commit message.

Four cohort projects converged on the same diagnosis from different angles this week: **the next useful agent layer is not a better model. It is durable memory, social routing, observable workflows, and human override — treated as a single system, not as four plugins.** #contexto attacks the memory side. #teleport-router routes work between humans and agents. #jjhub (Smithers) gives workflows durability and time-travel. #tinycloud's autonomous DAO experiment stress-tests what happens when none of that is present. Taken together, they describe the same product.

## what surfaced this week

### 1. Context window collapse is the failure mode that nothing else fixes

Shashank (#contexto) gave the cleanest framing of the underlying problem: *"context is basically everything that your agent sees before it helps… once the context window got full, it compacts, which might be lost, and some of the key concerns are lost in this process."* The compaction isn't a model bug. It is the architectural reality every agent today runs on. Bigger windows, sliding windows, raw markdown dumps — Shashank walked through and dismissed each in turn before describing the actual fix: an indexer that clusters episodes (prior agent runs) hierarchically and retrieves the right context for the current step deterministically.

This is the layer that has to exist before any of the other ones do useful work. Smithers can save every workflow output to SQLite, Router can publish every commit to a team channel, the agent DAO can vote on its next task — but if the next prompt the agent sees is a compacted summary that lost the actual reasoning, the system reconverges to the same lossy steady state.

For the cohort: every agent project here has a context-eviction problem hiding inside it. #contexto is the project that's named it explicitly, but #elizaos, #wikigen, #signalstack, #conclave, and the Pasio-style multi-agent setups all run into the same edge.

### 2. Long-running agents die without durability primitives

Will (#jjhub) opened Smithers' design with the archetypal failure: *"you might start some kind of workflow, maybe wrote a JavaScript workflow, and you started, and then you go to bed, and you wake up, you realize that you had like silly bug, and it just never ran overnight."* That is not a corner case. It is the median outcome of every long-running agent task in the cohort today.

Smithers' answer is five primitives stated as a unit: durable steps, persistent state, parallel execution, event-driven flows, and observability. The cohort is used to seeing these as separate concerns (Temporal handles durability, OpenTelemetry handles observability, etc.) but Will's claim is that for agents you need them in one runtime because they fail as a unit. An agent that can be restarted from frame 7 but can't be inspected has nothing useful to restart into.

The most cohort-relevant Smithers detail: **hot mode** — the ability to change a prompt while the workflow is mid-flight and have it re-render on the next tick, no restart required. That is the difference between debugging an agent and rewriting it. For projects with long-running operations (#teesql cluster bootstrap, #tinycloud outreach pipelines, #wikigen content generation), hot mode is the primitive that turns a one-shot agent into something a human can steer in real time.

### 3. Agent work disappears into private sessions — Router is the routing primitive

Andrew Miller (#teleport-router) framed the social side directly: *"for a long time, I would spend a ton of time posting on Twitter… in the past couple of years, I've retreated off of Twitter… I'm spending all of my time in my three to six [Claude Code] tabs, and that's a huge problem in missing out on serendipity."* Router's design is exactly the inverse: an MCP server that ambient-harvests the exhaust from your agent sessions (diffs, decisions, commits) and routes it as posts into team Slack/Matrix/email, plus a dynamic tool description that injects what teammates have posted *back into* the agent's context.

That second half is the subtle part. Router is not a notification layer bolted on top of agents — it is a memory layer that uses other humans' work as input. The agent literally sees more of the cohort's context than the human running it does. That's why the cohort instance matters: a private Router is a personal feed; a cohort Router is a shared substrate that makes hallway conversations replayable.

For the program's retroactive-attribution rubric, this is structurally important. If your contribution to another team's project happens inside an agent session and never surfaces, it doesn't exist on the rubric. Router is one way to make sure it does.

### 4. Heartbeat files and persistent state are load-bearing infrastructure

Hudson (#tinycloud) ran the cleanest negative experiment of the week — an autonomous agent DAO that votes on its own next task using IPFS-backed shared state. The instructive failure: *"if I leave it running overnight, I go back to it in the morning, and all these agents are spinning up for like 30 seconds in a heartbeat, and they're being like, 'Oh, there's nothing to do.'"* Hudson's diagnosis: *"the heartbeat file matters the most. The first thing you're seeing has the most impact on what rules it will actually follow, and then any other, like, down the nested hierarchy of files, it will get just worse and worse."*

LSDan, who has run agents for 16 hours autonomously on a dedicated machine, confirmed the same shape: *"reading the whole and relevant context, and then being like, 'Nothing.'"* The model is trained on user-driven chat. Absent fresh input, it converges to inactivity. The fix is not a better prompt — it is a memory architecture that keeps the *most directive* context closest to the head of every loop, with structured persistence underneath.

This is the layer #contexto is solving generically. The cross-project insight: **every agent runtime in the cohort needs a heartbeat-equivalent**, and the cohort would benefit from one shared definition of what that file looks like rather than five.

### 5. Human override is the safety layer, not a future feature

LSDan offered the most concrete operational warning in either day of intros: while a long-running agent was running unsupervised on his dedicated machine, *"one of the things it did at some point was it exposed the raw Postgres, like unconfigured, unpassword-protected port, and a malware bot scanned it and found it and injected a crypto miner into the machine, so it was running 100% CPU non-stop."* It was caught manually, not by the system.

This is the negative space around all the other proof-points. Memory, workflows, routing — none of it protects against an agent doing something operationally catastrophic while no one is watching. Smithers' approval nodes (workflows that halt for human input) and Router's posting-as-default behavior (every meaningful agent action becomes a visible post) are the two cohort projects that make the override layer real. The third piece — the policy layer for what agents can do unsupervised — is missing.

For #teesql, #abra, #tinycloud, #conclave (anyone running agents against production-adjacent infra): this is week-3 work, not month-3 work. The crypto miner is a cheap warning. The next one won't be.

### 6. Goal-mode is the paradigm shift the agent layer is moving into

Will closed his Smithers demo with a forward claim: *"things are moving more towards… instead of like thinking of things in terms of breaking down a hard problem to pass, think of it in terms of measurable goals, like almost giving your agent an OKR… giving your agent a lot of room to improvise its way to a goal."* The cohort's task-decomposition projects (Smithers' workflow trees, Hudson's voting DAO, Shashank's episode indexer) are all converging on this from below.

This is worth naming because the cohort's instinct is to build *for* the current paradigm (decompose → schedule → execute). If Will is right, the projects that age best are the ones whose primitives still work when the prompt becomes *"this is the outcome; figure it out, and show me your work."* That changes what observability has to look like.

## a moment worth naming

Across Day 1, Day 3, and Friday's session, the same insight surfaced four times under four labels:

- Shashank called it **context routing** — the right context to the right agent at the right step.
- Andrew Miller called it **work-exhaust harvesting** — turning private agent output into shared cohort memory.
- Will called it **observability** — the ability to look at any frame of a long-running workflow and understand why.
- Hudson called it **the heartbeat problem** — the file that sits closest to the head of the loop determines what the rest of the system actually does.

Four people, four projects, one architecture. None of them used the others' vocabulary. If those four projects sit down together this week and agree on a shared interface — what does the "current context for this agent right now" object look like, in terms any of them could consume — the cohort would have something no individual project could produce alone.

### other cross-project connections this week

- #contexto (Shashank) ↔ #teleport-router (Andrew Miller) — both solve "surfacing the right context at the right time"; Contexto from the agent's perspective, Router from the team's. Probably one substrate.
- #jjhub Smithers (Will) ↔ #teesql (LSDan) — Smithers' durable-steps primitive is exactly the shape LSDan needs for confidential-compute bootstrap workflows where every step is both an operational requirement and an audit artifact.
- #tinycloud agent DAO (Hudson) ↔ #pasio-style multi-agent (LSDan) — Hudson's voting/heartbeat experiments and LSDan's coordinator/sub-agent monitoring are the same architecture with different governance assumptions. The diagnostic moments (the "Nothing" agent) match line-for-line.
- #jjhub Smithers (Will) ↔ #teleport-router (Andrew Miller) — Smithers' approval nodes need to post somewhere a human will see them. That somewhere is Router. There is a one-week integration window here.
- #contexto (Shashank) ↔ #jjhub (Will) — Smithers stores every workflow output; Contexto indexes prior agent episodes. Same primitive, different consumer. A shared schema would mean Smithers users get retrieval-grade history for free.

## what to do with this

Concrete moves, ranked by who they're for:

- **#contexto, #teleport-router, #jjhub, #tinycloud.** Schedule a 90-minute working session this week, before Friday retro, on the question: *what does a shared "current context" object look like that any of the four projects could consume?* Even a strawman API is more valuable than any individual project shipping in isolation.
- **#elizaos, #signalstack, #wikigen, #conclave, #pramaana, #shake, #etherea** — anyone running agents inside their product. Audit your own context-eviction story this week. If you can't describe what happens when the agent's window fills, you have a #contexto-shaped hole.
- **Anyone running long-running agent operations against shared infra.** Put an approval node or a Router post in the loop before week 3. LSDan's crypto miner is the cheap version of this lesson.
- **Andrew Miller, Will, Shashank, Hudson.** Write one paragraph each, in your own project's voice, on what *your* project assumes about durable memory. Diffing those four paragraphs is the cheapest way to get to a shared substrate.
- **Anyone building agent primitives.** Ask the goal-mode question now: when the task interface is *"here is the outcome, improvise"*, does your project still help? If no, name what changes.

## open questions for the cluster

- What is the smallest shared "current context for this agent" interface that #contexto, #teleport-router, #jjhub, and the cohort's other agent runtimes could all consume?
- Where does the policy/sandbox layer live? Smithers gates per-workflow, Router publishes-by-default, but neither bounds what an autonomous agent is allowed to do against shared infra.
- Is heartbeat-as-architecture (Hudson's pattern) general enough to be a primitive, or is it cohort-specific tribal knowledge?
- How does the cohort instance of Router get adopted without turning into a noisy notification stream? The signal/noise problem is the routing problem.
- What does goal-mode observability look like — what does an audit trail of "the agent improvised, here is why" actually contain?

## voices from the room

Verbatim where possible. Auto-transcribed, so some lines carry mishears — preserved with `[sic]` where meaning still reads.

### Shashank (#contexto / sm86)

- on context as substrate: *"context is basically everything that your agent sees before it helps, like all the inputs to the evidence. It can range from the system prompts, sold skills[sic], tools, whatever you enable, to the runtime things… once the context window got full, it compacts, which might be lost."*
- on the agent-to-agent gap: *"the current workflow is like — I'm using my agents, [it] sends [a result] off to me, I'm copy-pasting it, sending it to my colleague, and then giving his Cloud Code agent the same prompt. Ideally, my agent should be just talking to his agent."*
- on selective trust: *"the trust companies are different. You trust all the systems that you want. You might not really trust my query studio."*

### Will (#jjhub, Smithers)

- on durability as a unit: *"durable steps — when things go wrong, like your computer runs out of power, whatever, you get rate-limited, you just need the ability to restart it and have confidence everything's gonna work. You need persistent state. You need the ability to do parallel work. Event-driven flows. Observability is really one of the biggest things."*
- on overnight failures: *"you might start some kind of workflow, you go to bed, and you wake up, you realize that you had like a silly bug, and it just never ran overnight. That's like the type of thing that happened to me all the time."*
- on hot mode: *"any point if Smithers is running, you can actually — say it's running Cloud Code — you can hijack it. I can actually go change the prompt in real time, and we'll just — you won't even have to restart it."*
- on paradigm shift: *"think of it in terms of measurable goals, like almost giving your agent an OKR… giving your agent a lot of room to improvise its way to a goal."*
- on framework fatigue: *"a thing that's really popular right now is these one-size-fits-all orchestration frameworks. I think these are really cool experiments, but I don't really see these having staying power."*

### Andrew Miller (#teleport-router)

- on the visibility problem: *"for a long time, I would spend a ton of time posting on Twitter… in the past couple of years, I've retreated off of Twitter… I'm spending all of my time in my three to six [Claude Code] tabs, and that's a huge problem in missing out on serendipity."*
- on Router's design: *"the first problem this solves is basically harvesting the exhaust — the way James puts it — from my [Claude Code], I'm now turning it into posts and recapturing some of the serendipity effect."*
- on the routing UX challenge: *"the real challenge in the art of this — the prompting quality and what goes into the tool description really shapes everything. Maybe there's some alpha that people can keep proprietary about a very effective water-cooler-value prompt."*

### Hudson (#tinycloud agent DAO)

- on the heartbeat problem: *"if I leave it running overnight, I go back to it in the morning, and all these agents are spinning up for like 30 seconds in a heartbeat, and they're being like, 'Oh, there's nothing to do.'"*
- on memory architecture: *"the heartbeat file matters the most. The first thing you're seeing has the most impact on what rules it will actually follow, and then any other, down the nested hierarchy of files, it will get just worse and worse."*
- on system-level regression: *"there's something at the [Claude] system level causing this regression. Usually your humans are prompting AI, and system prompts have been designed for that — they get to this point where they're like, 'There's been no input for a while, I guess I should just do nothing.'"*
- on durable-work governance: *"they're all on chain — the descriptions and everything they made on IPFS… they have different voting power based on how much they've contributed."*

### LSDan (running agents on a dedicated machine)

- the crypto miner incident: *"one of the things it did at some point was it exposed the raw Postgres, like unconfigured, unpassword-protected port, and a malware bot scanned it and found it and injected a crypto miner into the machine, so it was running 100% CPU non-stop… somebody was getting the value of the resource. The problem was it wasn't a very good miner, and so it kept crashing my system."*
- on the manual loop: *"most of what I have to do manually is kick it and tell the coordinator to look at its agents and see what is it currently doing… I've actually managed to run for 16 hours autonomously like that, effectively, but usually it's more like two or three hours."*
- on augmentation framing: *"I don't buy the worldview where we're replacing humans with AI. We're augmenting humans with AI — and humans who are incompetent, that incompetence is going to show a lot faster than it used to."*
- on the trust model: *"it's just like trusting your developers, but verifying your outcome."*

## resources mentioned

Anything named across the four sessions, with provenance. URLs only when stated verbatim in the source or trivially derivable from a stated repo/team slug.

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **Contexto / Context Indexer** | Episode-clustering indexer that retrieves the right context for the current agent step; deterministic retrieval over compacting | Shashank (#contexto / sm86) | repo via cohort team record `#contexto` |
| **Teleport Router** | MCP server that harvests agent work-exhaust into team channels and injects peer context back into the agent's view | Andrew Miller (#teleport-router) | `router.teleport.computer` (public instance); cohort instance forthcoming |
| **Smithers** | Durable agent workflow runtime — durable steps, persistent state, parallel execution, event-driven flows, observability, hot mode | Will (#jjhub / fucory) | repo via cohort team record `#jjhub` |
| **JJ Hub** | Experimental GitHub-alternative for agent sandboxing; co-evolves with Smithers | Will | code-name; not yet released |
| **#tinycloud autonomous agent DAO** | Voting/IPFS-backed autonomous agent experiment with shared on-chain state | Hudson | cohort team record `#tinycloud` |
| **Pasio-style multi-agent setup** | Dedicated-machine multi-agent coordinator (Hermes/GLM orchestrator + Claude/Codex/OpenCode sub-agents, worktrees, mobile access) | LSDan | personal production system |
| **Hermes / GLM 5.1** | Orchestrator model used in LSDan's setup for long-running coordination | LSDan | — |
| **Claude Code (Max tier)** | $200/mo Anthropic CLI subscription | Hudson, LSDan, Will | Anthropic product |
| **AMP** | Pre-configured agent harness with 200k token window + "Hand Off" compaction | Will | — |
| **Conductor.build** | UI for multi-agent task/conversation management | Hudson | — |
| **Playwright + MCP** | Browser automation + testing for agent UI verification | Hudson | open-source |
| **IPFS** | Cross-device persistent storage; substrate for Hudson's shared agent state | Hudson | — |
| **SQLite (via Smithers)** | Persistence layer for every Smithers workflow output | Will | — |
| **Zod** | TypeScript schema validation; used inside Smithers for output validation | Will | — |
| **React-as-AST** | Smithers' design choice — represent workflow tasks as a React component tree, enabling LLM-shaped workflow authoring | Will | conceptual |
| **Approval node** | Smithers workflow primitive that halts for human input | Will | — |
| **Hot mode / time travel / fork-from-frame** | Smithers observability primitives | Will | — |
| **Heartbeat.md pattern** | The file at the top of an agent's loop that determines drift behavior | Hudson | conceptual cohort-shared pattern |
| **Goal-mode / OKR-mode** | Emerging agent UX: tasks expressed as outcomes rather than decomposed task trees | Will | conceptual |
| **Matrix (E2EE)** | End-to-end-encrypted messaging used by Andrew for local-laptop-to-desktop agent comms | Andrew Miller | program canonical channel per `program/rules.md` |
| **Zmux** | Tmux rewrite in Zig | Will (fucory) | open-source |

## why this article exists

Four cohort projects are converging on the same architecture from four different starting points, none of them using each other's vocabulary, and the cohort has roughly three weeks before the June 14 demo night to either agree on a shared substrate or ship four parallel ones. The success rubric rewards collaborative contribution retroactively, but retroactive only works if the cross-project moves happen on the record. This is the prompt: name the convergence, surface the shared primitive, and build the integration before the public checkpoint forces you into separate booths.

---

*Sources: Day 1 project intro session notes (2026-05-19), Agents Day 3 project intro session notes (2026-05-21), Dumb Agent Tricks session notes (2026-05-21), Friday session notes with Shaw and Greg (2026-05-22). See also article #3 (`verifiability-is-becoming-ux-for-ai-infrastructure.md`) for the parallel infrastructure conversation in the #dstack cluster.*
