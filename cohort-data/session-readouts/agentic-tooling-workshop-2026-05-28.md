---
vault_id: agentic-tooling-workshop-2026-05-28
date: 2026-05-28
title: "Agentic Tooling Workshop: Workflows and Spells"
kind: workshop
consent: cohort-internal
teams: [elizaos]
people: [andrew-miller, dmarz, shaw-walters]
source: private-vault:agentic-tooling-workshop-2026-05-28
---

# Agentic Tooling Workshop: Workflows and Spells

**The interface layer, not the model, is the daily-use bottleneck.**

*A checkpoint workshop on the agentic interface and workflow layer — what people would actually use every day, and how self-optimizing, directable workflow runners could get there.*

## the 60-second version

Framed as an agentic role within the accelerator — helping everyone think through the interface and workflow layer — the workshop kept returning to one test: what would you use every day that gives you an hour back? The room converged on composable, switchable workflows and self-optimizing runners that try variations, measure success, inspect failures, and repair themselves, surfacing an editable workflow graph so automation stays legible and directable rather than a passive background projection.

## themes

- The agentic interface/workflow layer as the real product surface
- Composable, switchable workflows over single-shot automation
- Self-optimizing and self-healing workflow runners
- Giving users back time as the value test

## insights

- The framing test for an agentic tool is daily usefulness: the most valuable surface is the interface someone uses to seed and direct agents, measured by whether it gives an hour a day back rather than by raw capability.
- Operating-system-level input/output traces of workflows become valuable precisely when they can be captured, automated, and shared.
- A workflow system's core need is easy switching and composing of workflows — composition, not one-shot automation, is what makes it an instrument.
- Prompt and workflow optimization belongs in the tool: try variations, measure success rate, and improve; the stronger version is a hosted runner that self-authorizes, runs, inspects failures, and repairs itself.
- Self-optimizing workflows can generate a graph of the workflow — the user states intent, the system shows the graph, and the user confirms or edits it — which keeps automation legible and directable.
- A passive tool reads as background projection; one users can direct becomes a workflow (or even artistic) instrument, so directability is what makes it stick. Benchmarks are run repeatedly until harness problems are fixed, and packaging remains the gap.

## q&a

**Q: What makes an agentic tool worth using every day?**

A direct interface for seeding and directing agents that measurably gives time back — an hour a day was the bar named in the room — rather than a more capable but passive system.

**Q: Passive versus directable agentic tools?**

A passive tool feels like background projection; making it directable turns it into a workflow instrument people actually adopt.

**Q: How do you improve a workflow automatically?**

Try prompt and workflow variations, measure success rates, and iterate; the stronger form is a hosted runner that self-authorizes, runs, inspects its own failures, and self-repairs, surfacing an editable workflow graph.


## references

- [Smithers durable workflow orchestrator](https://smithers.sh)
- [elizaOS](https://github.com/elizaOS/eliza)

## provenance

Distilled from a private-vault transcript (`agentic-tooling-workshop-2026-05-28`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `cohort-internal`.
