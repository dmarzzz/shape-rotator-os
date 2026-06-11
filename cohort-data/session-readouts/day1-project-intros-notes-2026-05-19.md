---
vault_id: day1-project-intros-notes-2026-05-19
date: 2026-05-19
title: "Day 1 Project Intros: Info Markets and Consumer Agents"
kind: intros
consent: cohort-internal
teams: [daedalus, feedling, etherea]
people: [freya-zhang, james-barnes, gonzo-gelso, andrew-miller, sxysun, rajat-verma, sri, wiktoria-leks, dmarz]
source: private-vault:day1-project-intros-notes-2026-05-19
---

# Day 1 Project Intros: Info Markets and Consumer Agents

**Three first-day pitches, one shared question: who is this actually for?**

*First project-intro afternoon of the cohort: a prediction-market hedging agent, a behavior-modulating consumer agent stack, and a live conversation visualizer, capped by agentic-workflow swaps and a generalized founder-journey fireside.*

## the 60-second version

The cohort's opening project-intro afternoon ran three very different bets — a prediction-market hedging agent, a privacy-preserving behavior-modulation stack, and a live speech-to-visual stage system — before drifting into how people are really building, with parallel coding agents, evals, and local models. The pressure from the room was less about the technology than the customer: every presenter got pushed to name a single ideal user, and most were still guessing.

## themes

- Turning prediction markets into practical hedging infrastructure for ordinary portfolios
- Consumer agents that mediate attention and behavior under strong privacy guarantees
- Real-time generative media as a presence and engagement tool in physical space
- Agentic engineering workflows: parallel coding agents, evals, and local-first tooling

## insights

- One info-markets approach decomposes a stock or crypto portfolio into risk factors, maps each factor to prediction-market events, then simulates candidate event baskets to construct a cheap hedge against idiosyncratic risks that conventional options cover poorly; positions are framed as one-time insurance rather than continuously rebalanced hedges because binary contracts decay toward resolution.
- Execution on thin binary markets was treated as a first-class problem: an RFQ layer lets market makers quote and split large orders before they touch the public book, and protected order-flow research from the IC3 lineage was raised as the natural mechanism for shielding hedge trades from front-running where price impact is large.
- Market making on prediction markets was characterized as structurally unprofitable today because venues subsidize liquidity without sophisticated binary-option pricing; the team argued that applying options-style pricing models to event contracts can convert that subsidy into sustainable spread capture.
- The consumer-agent intro framed the user as a black box modulated through inputs and outputs: ambient screen capture feeds an agent that distills daily activity into reusable skills, while a notification engine scored against a hand-built rubric acts as the output channel for nudging behavior toward a stated daily intention; statuses are encrypted per-friend and shared over a public relay.
- A reusable privacy pattern was presented for agent backends: user data stays encrypted at rest, and any developer upgrade to an attested enclave deployment requires fresh user approval unless the user explicitly opts into auto-approval, trading a little convenience for verifiable control over what code touches the data.
- Mobile platforms cannot do ambient capture, so the workaround is delegated access to watch history via a contained browser session; campaign experiments showed delegation onboarding converts in the single digits largely due to authentication friction, while hardcore AI-companion communities proved the most informative early users because they already endure extreme setup pain and surface the hard problems like memory portability and proactivity tuning.
- The live-visualization team reported a counterintuitive engagement effect: real-time speech-to-visual generation increases audience attention on the speaker because people keep checking whether the system depicts what is being said; informal audience polling supported this and controlled experiments are being designed with cohort research input.
- Their tooling stack pairs a real-time inference layer that decides when to update versus create scenes (including cache management for live video models) with an open-source compositing and projection-mapping pipeline and a nightly autonomous loop that generates and self-scores shaders against a rubric; a single design constraint, rendering people only as silhouettes, eliminated the large majority of inappropriate-output failures.

## q&a

**Q: How does an event-hedging agent handle execution and rebalancing on illiquid books?**

Orders route through an RFQ layer where market makers quote and large trades get split, with protected order flow proposed for the final on-chain leg; the product deliberately sells one-shot insurance positions instead of dynamic rebalancing, since binary contracts bleed value if held and adjusted continuously.

**Q: Who is the ideal customer for these consumer-facing market and agent products?**

Presenters were pushed repeatedly to name a single ideal profile; answers ranged from ordinary stock holders (chosen because that addressable market dwarfs crypto) with institutions served separately via a prime-brokerage-style surface, to high-intensity AI-companion power users as a wedge for behavior-modulating agents.

**Q: How would a behavior-modulation agent monetize?**

Models discussed included subscription access to a continuously synthesized knowledge base with premium live-expert upsell, vertical-specific curated libraries for life transitions, and gamified healthy-habit framings — with the presenter conceding the health angle currently lacks supporting evidence versus simply locking the phone away.

**Q: What did the agentic build workflows actually look like?**

One presenter built nearly the whole product with agentic engineering and described a progression from AI as code writer, to agent-written mocks, to fully automated end-to-end testing, advancing a stage whenever frustration peaked; others compared parallel coding-agent terminal counts, message-driven agents reachable from a phone, and local open-source models on consumer GPUs as the next experiment.

**Q: How do you keep a live generative system aligned with speaker intent without taking speech too literally?**

Heavy investment in evals plus an auditor-style model that scores whether intent was understood and fulfilled at the right moment; presenters argued design constraints that remove whole failure classes beat per-case correction, and floated audience-reaction signals as a future reinforcement input.


## references

- [Polymarket](https://polymarket.com)
- [Claude Code](https://claude.com/claude-code)
- [Matrix (cohort coordination)](https://matrix.org)
- [shaperotator.xyz](https://shaperotator.xyz)

## provenance

Distilled from a private-vault transcript (`day1-project-intros-notes-2026-05-19`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `cohort-internal`.
