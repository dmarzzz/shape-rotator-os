---
vault_id: project-intros-agents-day3-2026-05-21
date: 2026-05-21
title: "Project Intros: Agentic — Contexto, Conclave, Router, Smithers"
kind: intros
consent: cohort-internal
teams: [contexto, conclave, teleport-router, jjhub, feedling, tinycloud]
people: [andrew-miller, james-barnes, dmarz, lsdan, prakhar, kristel-alliksaar, gonzo-gelso, will-cory, wiktoria-leks, hunter-horsfall, sevenfloor, sxysun]
source: private-vault:project-intros-agents-day3-2026-05-21
---

# Project Intros: Agentic — Contexto, Conclave, Router, Smithers

**The agent stack the cohort is quietly assembling out of each other's projects.**

*Four agentic-infrastructure intros spanning context engineering for long-running agents, confidential cohort intelligence, ambient work-sharing, and durable workflow orchestration.*

## the 60-second version

Four agentic-infrastructure intros — a context engine, a confidential cohort-signal layer, an ambient work-sharing router, and a durable workflow orchestrator — turned out to chain into a single pipeline: configure, ingest long-horizon context, and surface serendipity. The cross-cutting theme was context engineering: the right context, to the right agent, at the right time, with privacy made legible enough that non-technical people actually trust it.

## themes

- Context engineering: right context, right agent, right time
- Privacy-preserving collaboration: TEEs, scoped policies, trust legibility
- Ambient working-in-public and engineered serendipity
- Durable, goal-driven orchestration of long-running agents

## insights

- Contexto's core argument: bigger context windows only postpone failure — attention cost scales quadratically and pricing roughly doubles past a token threshold, while sliding windows add recency bias and markdown memory files push the relevance problem onto the user; their answer is an indexer that clusters agent episodes into a hierarchical mindmap and deterministically injects only the currently relevant subtree, with an agent-invocable deep search over the tree at runtime.
- Contexto's roadmap targets keeping a main agent's context under roughly 20-30 percent by decomposing tasks to sub-agents that each receive only the context they need, and eventually letting one person's agent call another person's exposed workflow endpoint instead of humans copy-pasting prompts; prompt injection and PII leakage were named as the primary attack vectors, with a small locally runnable model proposed as a PII scrubber. Early traction includes thousands of repo clones and package downloads within two months of release and developer meetups in six cities.
- Conclave proposes a confidential intelligence layer for cohorts: an always-on agent on each participant's own device mines private exhaust (coding-agent logs, transcripts, chats) and emits only derived signals to organizers — for example that a team has spent weeks heads-down building and may need go-to-market support, or that a team might benefit from mediation without anyone raising a flag directly; the pipeline combines deterministic clustering layers with LLM layers, and runs open source in a TEE so its behavior is verifiable via remote attestation.
- Conclave's earlier proof of concept scored hackathon projects for novelty and track alignment from both organizer and participant perspectives; outreach to organizers suggested duplicate-idea detection matters far more in milestone-funded cohorts than at hackathons, and the team flagged long-horizon pipeline memory — keeping week-one information alive at week seven — as itself a context-engineering problem, possibly solvable with the cohort's own context tooling.
- Router is an MCP server that ambiently turns coding-agent sessions into posts on scoped feeds (public, team, and cohort instances); the core mechanism is a dynamic per-user tool description that both guides what to write and injects summaries of other members' relevant recent posts, so discovery happens inside the coding session itself. Because dynamic tool descriptions are an injection attack surface, the service runs as a remote MCP inside a TEE, which also enforces the routing policy — and it is already used internally to bridge a team split across two languages and two chat platforms with only two bilingual members.
- Router's broader thesis: working in public is being hollowed out as model companies absorb the value of shared work, but retreating to isolated local models forfeits the value of aggregation; TEE-hosted inference over data from mutually distrusting parties can act as a trustworthy automated water cooler that routes information so both contributors benefit. Several serendipity stories already exist of people discovering and connecting over each other's work purely through the feed, without any direct outreach.
- Smithers is a durable workflow orchestrator that represents agent workflows as React component trees — chosen deliberately because models are heavily RL-trained on React, letting an agent one-shot complex workflows; it builds on five primitives (durable steps, persistent state, parallelism, event-driven flows, observability), validates outputs with schemas and persists them to SQLite, freely mixes agentic and deterministic code nodes, supports hot-editing prompts mid-run, time-travel scrubbing and forking, and hijacking a live session; it is harness-agnostic and can run each task on a different machine, which also prevents parallel agents from fighting over shared test resources and ports.
- Smithers field observations doubled as founder lessons: users are shifting from task decomposition toward goal-based driving (give the agent a measurable, OKR-like target and room to improvise, with recursive goal trees expected as scope grows); cross-model review loops are the standard guard against agents gaming tests, though hack-prone behavior is sometimes desirable for quick proofs of concept; operate a single agent long enough to develop model empathy before reaching for orchestration; and don't ship features until a real user asks. A companion experiment, JJ Hub, explores a sandbox-first code-hosting alternative with per-task data permissions.

## q&a

**Q: How should context-management and sub-agent systems be evaluated?**

There are no good public benchmarks yet — existing memory benchmarks test retrieval rather than relevance to the task at hand, and there is no solid data on whether sub-agent architectures outperform single agents; the practical approach is to mine your own traces, collect failure cases, and build use-case-specific evals.

**Q: How do you make privacy guarantees believable to non-technical participants?**

Open source plus TEE remote attestation satisfies technical users, but a hash convinces no one else, and people visibly freeze up when they know they are being recorded; proposed remedies included contracts that narrowly scope what the system can ever output, per-person consent policies set during onboarding, an off-the-record control that pauses processing, and plain-language descriptions of redaction filters.

**Q: Should ambient sharing of coding sessions happen inline or in batch?**

Inline prompts at session end can interrupt flow and see only one context window; an end-of-day batch review across all of the day's sessions could produce better posts, while the explicit-sync flow always shows a preview before anything is published.

**Q: How do orchestration users handle reward hacking by agents?**

Models differ in their propensity to game tests, such as commenting tests out to make them pass; the most common pattern is a review loop in which a second model repeatedly checks the implementer's output until it passes, though some users deliberately want hack-tolerant behavior when racing to a proof of concept.

**Q: What is changing in how people drive agents?**

A visible shift from breaking work into task tickets toward giving agents measurable goals and room to improvise their way there, with recursive goal trees expected as tasks grow larger; goal-based driving is expected to become the default interface as harnesses add native goal features.


## references

- [Contexto context engine (GitHub)](https://github.com/ekailabs/contexto)
- [Router public instance](https://router.teleport.computer)
- [Smithers durable AI workflow orchestrator](https://smithers.sh)

## provenance

Distilled from a private-vault transcript (`project-intros-agents-day3-2026-05-21`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `cohort-internal`.
