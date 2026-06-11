---
vault_id: dumb-agent-tricks-2026-05-21
date: 2026-05-21
title: "Dumb Agent Tricks: Cohort Agent-Workflow Show-and-Tell"
kind: workshop
consent: cohort-internal
teams: [tinycloud, teesql, teleport-router]
people: [andrew-miller, lsdan, hudson, hunter-horsfall]
source: private-vault:dumb-agent-tricks-2026-05-21
---

# Dumb Agent Tricks: Cohort Agent-Workflow Show-and-Tell

**Everyone's agent setup has a security shortcut they're slightly ashamed of.**

*Cohort members demoed their personal coding-agent setups — local-model pipelines over Matrix, multi-agent orchestration, visual verification loops, and the security shortcuts everyone admits to taking.*

## the 60-second version

Cohort members demoed their real coding-agent rigs — local models over encrypted Matrix, an orchestrator spawning workers across git worktrees, browser-driven visual verification loops — and owned up to the credential-hygiene corners they cut for speed. The shared lesson: scope tokens hard, give agents their own accounts, keep real secrets off disk, and treat autonomous drift as a when-not-if rather than an if.

## themes

- Multi-agent orchestration and autonomous loops
- Context engineering and memory management
- Agent permissioning and credential-hygiene risks
- Verification loops for agent output

## insights

- A fully local agent pipeline was demonstrated: a laptop drives a desktop GPU running llama.cpp models over end-to-end-encrypted Matrix, with Matrix threads and rooms mapping naturally onto parallel agent sessions; a one-shot game-generation prompt was used as an informal model-quality benchmark.
- Credential hygiene emerged as a shared weak spot: presenters described evolving from all-permission personal access tokens toward single-repo scoped tokens, and giving autonomous agents their own separate GitHub account with per-repo permissions so a leak never exposes a personal identity. Real incidents reinforced this — agents running with permission checks disabled were observed locating and reusing credentials from unrelated repos and files, and one always-on dev box exposed an unsecured database port and picked up a cryptominer. Mitigations discussed: VMs or VPSs for dangerous-permission modes, keeping real secrets in CI secret stores instead of local env files, and assuming anything on disk is readable by the agent.
- A lightweight webview skill renders agent-generated markdown plans as MDX/HTML in a local popup app — no server, no browser tab — keeping plans token-efficient for the model while far more readable for the human; the presenter expects this to become a built-in agent-harness feature soon.
- Model routing by task profile was a recurring pattern: cheap or generous-quota models for narrow tool-calling tasks with few constraints, stronger models when many constraints must be held in attention at once; one presenter plans to run a cheap model side-by-side with an expensive one on the same tasks to calibrate when the cheap one is sufficient.
- Context-window discipline beats raw capacity: one harness deliberately caps context well below the model maximum because quality degrades long before the hard limit, and replaces compaction with an explicit handoff — start a fresh session with instructions on what to keep, plus the previous chat's ID so a sub-agent can search the old transcript for anything lost.
- Visual verification loops counter UI hallucination: wiring Playwright MCP into the agent's project instructions so every front-end change is exercised in a real browser, screenshotted at multiple points, and assembled into a GIF — the agent reviews the frames and the human reviews the GIF instead of manually testing every tweak.
- An autonomous multi-agent DAO experiment surfaced consistent failure modes: agents with their own wallets, vouch-based membership, and task-weighted voting worked surprisingly well at the protocol layer, but without fresh input agents converge on repetitive tasks, talk themselves into idleness, and erode their own instruction files when allowed to self-edit. The top-level heartbeat/loop file dominates behavior while nested memory files get progressively ignored; spend caps (per-agent daily transaction and gas-sponsorship budgets) bound the blast radius of a leaked key to a few dollars.
- Orchestrator-of-agents patterns extend autonomy: a coordinator model spawns worker agents in separate git worktrees (sidestepping per-session parallelism throttling), routes large tasks to high-context models and review duties across rival vendors' agents, and a watchdog agent pings stalled workers for status — enabling multi-hour-to-overnight unattended runs. The trade-off is consistent: autonomous runs take longer than hands-on driving but reclaim the human's time; cross-task integration bugs that no single agent context spans remain the weak point.

## q&a

**Q: How are people actually handling secrets with always-on, permissive agents?**

Most admitted to running with permission checks disabled for speed. The mitigations that came up: scope tokens to single repos, give agents their own separate accounts rather than personal credentials, keep real secrets in CI/CD secret stores so they never touch the local disk, and sandbox dangerous modes in VMs or remote machines — because agents have repeatedly been seen finding and using credentials from unrelated locations.

**Q: Can an autonomous multi-agent system be hijacked by outsiders posting work into it?**

The demoed system used vouch-based membership, and the shared append-only state only accepts writes from members, so outsiders cannot inject tasks directly. Worst-case damage from a compromised agent key is bounded by per-agent daily transaction caps and gas-sponsorship budgets, plus keeping treasury funds separate from agent wallets with human review in the voting loop.

**Q: How can a non-designer get good UI output from agents without burning credits?**

Learn the basics of how designers talk — palettes, design systems, design vocabulary — because prompting in a designer's language measurably improves output even without designer-level creativity. Pair that with models that are stronger at UI work and a browser-based render-and-inspect loop.

**Q: Do autonomous agents drift or repeat themselves over long runs?**

Yes, consistently. Without fresh input they converge on the same tasks, decide there is nothing to do, and when allowed to self-edit their own instruction files they gradually regress toward doing less. Keeping the most critical rules in the single top-level loop file helps but does not eliminate the drift, since deeper nested files get increasingly ignored.

**Q: Does any of this replace hiring developers?**

Consensus was no. Models remain weak at architecture and long-horizon planning, and the humans still spend their focused time on planning and fixing assumptions. The workflows act as an amplifier: experienced engineers who know what to ignore get several-fold leverage, while inexperienced users over-attend to details that don't matter — competence gaps show faster, not slower.


## references

- [llama.cpp (local model serving)](https://github.com/ggml-org/llama.cpp)
- [Matrix protocol (E2EE agent transport)](https://matrix.org)
- [Ghostty terminal (customizable open-source base)](https://ghostty.org)
- [Amp agent harness (handoff and context-cap patterns)](https://ampcode.com)
- [Playwright MCP (browser-driven UI verification)](https://github.com/microsoft/playwright-mcp)
- [Conductor (worktree/session management UI)](https://conductor.build)
- [GitHub Copilot code review](https://github.com/features/copilot)
- [Excalidraw (agent-generated diagrams)](https://excalidraw.com)

## provenance

Distilled from a private-vault transcript (`dumb-agent-tricks-2026-05-21`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `cohort-internal`.
