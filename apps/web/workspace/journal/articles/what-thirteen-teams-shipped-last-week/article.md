# What thirteen teams shipped last week

*Why it's worth your two minutes: AI made writing code nearly free, so this recap tracks the cohort's real contest — distribution and sales — team by team, and where each one's PMF hunt actually stands.*

## TL;DR

The cohort's first **WDYDLW** ("what did you get done last week") standup — three-minute updates, two minutes of questions — at The Convent, New York, on **8 June 2026**, with #elizaos joining remotely and a visiting mentor present for the first half.

**The through-line.** AI has made writing code nearly free, so almost every team's real bottleneck is distribution and sales, not building: *"We don't have a product-creation problem. We have a product-sales problem."*

**The forcing function.** By end of week, ship one usable product at the ETH Global NY hackathon and send 100 cold messages to ideal users. Real user contact beats internal speculation.

**The PMF scoreboard** — each team's registered pitch on shaperotator.xyz set against what the room reported (the delta on its product–market-fit hunt):

- **Advanced** (moved toward its milestone) — Elocute · Teleport Router · Tinycloud · JJHub/Smithers · DealProof · Shape Rotator OS · Private LLM search
- **Reframed** (pivoted the wedge or ICP) — elizaOS · TeeSQL · Feedling · Daedalus · Contexto
- **Hard truth** (a gap surfaced) — Bitrouter

> Details and definitions (the Stage 1–7 scale, the visual edition, sources) are in the [Appendix](#appendix--double-click).

## around the room — who shipped what

*Each team leads with the verdict, then the supporting detail. Skim the bold lines; double-click where it matters to you.*

### Elocute — Advanced

**The signal.** Attacking the retention bottleneck with qualitative discovery rather than more features — *"one real user interview beat five days of speculation."*
**On the site.** #elocute — live AI speaking-practice app (elocute.fun): 538 users, ~39% 30-day active, strong organic content reach. Next milestone: turn active users into a repeatable weekly practice loop with a clearer paid-conversion signal. *Stage 5/7 · Retention.*
**In the room.** Ran a first structured user-research interview (with the #teesql team), prompted by cohort feedback, and designed three research cycles — interview three users, ship updates, re-interview those three plus three new ones. The work is compressing a flood of conversations into one executable product/UX plan ahead of the local hackathon; #elizaos pitched in on shipping recent app improvements.

### Teleport Router — Advanced

**The signal.** The "route through Teleport for a real cohort use case" milestone began to land via the Shape OS merge. The product is drifting from delegated posting toward a local-first daily log and a cohort cross-pollination feed.
**On the site.** #teleport-router — cross-network routing; public surface is one-time-use delegated posting (teleport.best). Next milestone: land one real cohort use case where another project routes an action through Teleport. *Stage 3/7 · Solution Quality.*
**In the room.** A new Daybook electron app and the "Day" project — a local daily log of your Claude-Code/Codex sessions — with a cloud-SDK onboarding flow; demoed at the Princeton event. The Teleport Router was PR'd into #shape-rotator-os — the first merged cohort-project-to-Shape-Rotator-OS contribution.

### Tinycloud — Advanced

**The signal.** The scoped-delegation milestone effectively met, with a live internal consumer (Listen). The customer search is sharpening around "people with lots of private transcripts," with a clear contrast vs. Teleport: personal aggregation vs. cross-pollination.
**On the site.** #tinycloud — user-owned cloud on dstack TEEs; live SDK + protocol; paid pilot with Sparq Gaming. Next milestone: get one cohort project using tinycloud-secrets for a real scoped-delegation workflow. *Stage 4/7 · ICP Clarity.*
**In the room.** (With the wider Tinycloud team.) Shipped single-message delegation in the encryption/sign protocol — a major simplification over interactive key exchange. tinycloud-secrets now powers "Listen," a transcript aggregator (Firefly/Granola/…). Shipped Tiny Cloud Chats (built on RedPill) for private AI chat, and finalized a policy engine that gates content by credential and trust graph. Building a personalized feed that mines a user's own transcripts into artifacts.

### JJHub / Smithers — Advanced

**The signal.** The cohort-integration milestone is landing through Eliza (#elizaos adopted Smithers as its workflow engine). The product crossed from fragile to stable → organic pull. The hunt now centers on serving a non-self ICP and a clean one-line position; a non-technical co-founder is being floated.
**On the site.** #jjhub — agentic coding platform; Smithers = durable agentic workflows as JSX (hit the HN front page); Tevm has an EF grant. Next milestone: get one cohort team using Smithers for a real agentic CI or review loop. *Stage 4/7 · ICP Clarity.*
**In the room.** Shipped the long-awaited UI (*"the dots are actually good now"*) — pixel-polishing the single most-requested feature for ~3–4 months. Recorded a podcast with an Ethereum Foundation researcher. Reframed positioning: "Smithers could be the Linear of workflow tools" (vs. Zapier / monday.com). The product stabilized from maintainer-dependent to genuinely usable; ~6 organic onboards, roughly doubling week-over-week with no marketing.

### DealProof — Advanced

**The signal.** From a dual-attestation primitive toward a concrete negotiation product, a provenance integration, and first customer-discovery outreach. Actively cross-pollinating with Contexto (memory) and Tinycloud (provenance).
**On the site.** #dealproof — TEE + post-quantum dual-agent contracts (Intel DCAP, on-chain escrow); 56 passing tests; Bradford Quantum Hackathon winner. Next milestone: get one cohort team to integrate the dual-attestation contract layer. *Stage 4/7 · Technical Risk.*
**In the room.** Enhanced the agent-to-agent negotiation app using the #contexto memory engine — CDN deal negotiations now carry memory across rounds (store a hash, recall prior terms). Implemented PiCred (arXiv:2606.03771) for provenance — verifying an agent's code wasn't tampered with — and is introducing the paper's authors to the cohort. Began scoping a product (an API platform inside a CVM) and cold-reached two AI-negotiation companies (e.g., pactum.ai) to find the pain.

### Shape Rotator OS — Advanced

**The signal.** Honest read: no PMF, but a working example of cohort coordination — and the first merged cohort-project contribution landed.
**On the site.** #shape-rotator-os — the cohort's own coordination layer and cohort viewer (dmarzzz/shape-rotator-os). Next milestone: open it to outside contributions and real cohort workflows. *Stage 2/7.*
**In the room.** Re-architected Shape OS for outside contributions and flagged the need for real user stories and product-driven development. The Teleport Router PR was the first merged cohort-project-to-Shape-Rotator-OS contribution.

### Private LLM search — Advanced

**The signal.** Idea → deployed, benchmarked prototype with a clear latency envelope (fine for agentic search, not low-latency).
**On the site.** #searxng-wth-frnds — a LAN-first peer search daemon plus DCNet-style anonymous broadcast. *Stage 2/7 · Technical Risk.*
**In the room.** Private LLM search with metadata privacy via flashnet. Tor exit nodes get blocked fast (Cloudflare/AI bans), so the work explored reputation-gated egress to prevent IP poisoning; a deployed prototype benchmarked 10k queries at median +1.2s latency, p99 ~9s.

### elizaOS — Reframed

**The signal.** The integration milestone effectively landed — Eliza now runs on two cohort tools — and the real constraint was named out loud: *"we don't have a product-creation problem, we have a product-sales problem."* Focus moved from capability to a buyer definition and last-mile distribution; an MVP (cloud, multiplayer, power users) and a possible non-technical co-founder are on the table.
**On the site.** #elizaos — mature open-source agentic operating system (runtime, cloud, desktop, mobile, plugins). The open question isn't validation — it's GTM. Next milestone: turn the broad ecosystem into one or two concrete cohort integrations with real downstream pull. *Stage 7/7 · GTM.*
**In the room.** Hard pivot to a new agent interface (the team expected a rival, Hermes, to ship a desktop app, so Eliza reworked its own). Swapped OpenRouter → cohort-mate #bitrouter (OpenRouter as fallback); swapped n8n → cohort-mate Smithers (#jjhub) as the workflow engine, shipping PRs back (GEPA reflective prompt self-optimization, a TUI). Built a sandboxed tiny-agent on #tinycloud; stood up hosted Eliza agents (Eliza Cloud); and ran a side stunt using agents to resolve most of the open lemmas in the arkworks zkSNARK library — years of proof work compressed into days, by the team's telling, though the top prize stayed out of reach.

### TeeSQL — Reframed

**The signal.** Broadened from one database to any confidential workload; customer search moved toward web2 enterprise. Candid self-assessment: *"nothing fundamentally defensible yet."* The bottleneck is migrating from technical risk toward ICP clarity and a moat.
**On the site.** #teesql — TEE Postgres on dstack, with an RA-TLS proxy and open-source attestation tooling. Next milestone: onboard one cohort team to the beta and document the full attested connection path. *Stage 4/7 · Technical Risk.*
**In the room.** Product-shape pivot: from a Postgres-specific high-availability cluster to a generalized, attestation-gated mesh that can run any open-source software (Clickhouse, Redis), with a blockchain control plane and host- or dev-proof modes. The ICP hunt moved off-cohort — European confidential-computing enterprises (e.g., a German firm reducing US-cloud reliance) reached via a web2 enterprise network.

### Feedling — Reframed

**The signal.** Alongside Elocute, one of the room's clearer consumer-traction signals; the PMF question shifts to retention and onboarding.
**On the site.** #feedling — information-diet interventions for short-form video using TEE-delegated watch history. *Stage 2/7 · ICP Clarity.*
**In the room.** A second consumer app — a customizable AI companion — is showing early interest from the Xiaohongshu (RED) community.

### Daedalus — Reframed

**The signal.** A facilitator's heavy steer de-risked the product from a "make-users-money" bot (fiduciary / broker-dealer exposure) toward a discovery tool for delta-neutral hedges — gated on rigorous correlation backtesting before any app is built. The core correlation is still unproven.
**On the site.** #daedalus — prediction-market microstructure research grounded in the PROF paper; building an orderbook-ingestion + backtest pipeline. Next milestone: show one backtest or live result that changes a market-making decision. *Stage 2/7 · ICP Clarity.*
**In the room.** Product = using Polymarket + sports events to hedge stock portfolios. Cited Polymarket's first institutional block trade (FalconX, an AI-compute price index) as evidence of institutionalization; scraping Polymarket historical L2/L3 orderbook data to quantify it. A new demo lands by end of next week.

### Contexto — Reframed

**The signal.** A facilitator's hard steer reframes the wedge from agent-coordination infra toward a mass-market personal assistant — *"a market 1,000–1,000,000× bigger."* Another facilitator pushed back: agentic executive assistance is a brutally hard product — too personal to get right, with impatient, error-intolerant buyers. The wedge is contested; the near-term move is a personal-assistant PoC plus more discovery.
**On the site.** #contexto — agent context engine; episode-based memory across runtimes (OpenClaw plugin). Next milestone: instrument one cohort agent workflow end-to-end and show better recovery/continuity. *Stage 3/7 · Solution Quality.*
**In the room.** A deep dive on coordination topologies — Paradigm's "Centaur" — and a design where user preferences and code logs stay on local edge devices while routing happens through a centralized, privacy-respecting router. Built a personal to-do/journaling agent on Hermes; interviewed executive assistants on LinkedIn (a $200–$5,000/mo personal- and executive-assistant market).

### Bitrouter — Hard truth

**The signal.** Sharper positioning plus a real distribution spike (stars 2×) — but the conversion truth surfaced: 0 paid. The hunt pivoted to a supply-side moat (token deals) and a conversion funnel. As one facilitator put it: a red-ocean aggregator game where the edge is cost and grind, not features.
**On the site.** #bitrouter — P2P LLM router; live at bitrouter.ai; opening up x402-kit and accepting cohort dogfooders; Phala-CTO referral. Next milestone: get a cohort team using x402-kit / Bitrouter inside a real agent workflow. *Stage 4/7 · ICP Clarity.*
**In the room.** Repositioned the site from "open intelligence router" to a sharp pain point: reliability + cost for coding agents. After a facilitator retweeted it, GitHub stars doubled. Shipped a feature combining Claude/Codex subscriptions with open-source models for cheaper workflows. Wired in analytics: ~10% of signups activate; zero have paid — now reaching out to non-payers one by one. Supply-side edge: legal, cheap Chinese tokens via the Phala network.

## patterns — themes that ran through the room

1. **Code is commoditized; selling isn't.** If an MVP of almost anything can be built in two weeks, the table-stakes part is done. The hard part is naming a customer who will actually pay — and most teams admitted they were still guessing at theirs.
2. **Don't be a fiduciary.** For the finance-adjacent teams, a facilitator drew a bright line: a bot that makes other people money is a fast path to fiduciary and broker-dealer risk. Build discovery and intelligence tools instead — and back-test the correlation before building the app.
3. **Reach the last mile; sell to normies.** Developers and open-source maintainers are the worst customers to sell to. The far larger market is ordinary users who want an agent that just works — own the end product rather than depending on platforms that can absorb you.
4. **Aim for a six-month moat.** Nobody expects a permanent edge when everything is one-shottable. The realistic goal is a defensible six months — bought with cheap supply, private data, real relationships, and speed.
5. **The cohort is the distribution.** Eliza now runs on #bitrouter and Smithers; Teleport's router merged into Shape OS; #dealproof is wiring in #contexto and py-credits. A facilitator's pitch for ETH Global: bundle these into one demo and share attribution — collaborative distribution over solo launches.

> "Just assume everything can be one-shotted — then build from that world." — a facilitator, on where the real work now lives

## appendix — double-click

*The tangents a tree can't hold: how the scoreboard was scored, the week's forcing function in full, the side projects, and provenance.*

### How the PMF deltas were scored

Each project's registered pitch on shaperotator.xyz (focus, ICP, journey stage, bottleneck, next milestone — the same data that powers the cohort viewer) is set against what the room reported, and the delta on its hunt for product–market fit: **advanced** (moved toward its milestone), **reframed** (pivoted the wedge or ICP), or **hard truth** (a gap surfaced). Stages 1–7 are the cohort's own PMF-journey scale. The format itself was modeled on an accountability email one facilitator ran in a16z days, mixing "what I actually shipped" with "here's the project." A fuller, styled edition of this recap lives at [the visual edition](/workspace/journal/recaps/what-we-shipped-2026-06-08/), and the full reconstructed text is bundled in the OS context vault.

### The week — one product, one hundred messages

The cohort set a single forcing function for the midpoint week: each team ships a concrete, usable product to demo at the ETH Global New York hackathon (turn-in Sunday), and each founder sends 100 cold messages to their ideal users to validate direction. Teams that can't field a full crew were urged to bundle into a shared project and split attribution, and to step up project managers since several members travel that week. The accelerator also floated a half-serious metric — the "one-shot challenge": if the facilitators' agents can one-shot 80% of your product, that's your cue to question the moat and find the niche only you can serve.

### Side projects from the room

Two more from the same corner of the room: an IC3-camp hackathon project — a "try-before-you-buy" marketplace for proprietary agent skills, benchmarked against a buyer's withheld test set and licensed to run inside a TEE — won the camp's "funniest project" award. Separately, a personal security audit of EigenLayer's DarkBloom (idle Macs as a decentralized inference network) reads that its Mac remote-attestation doesn't deliver the security it claims — a follow-on to the Agentic Organizations salon.

### Provenance

Reconstructed from an automatic transcript of the cohort's first WDYDLW standup (The Convent, New York, 8 June 2026). The "on the site" baselines are each team's own self-reported journey data from the cohort dataset — the same records that power the cohort viewer — not an external assessment. The in-room single-device capture collapsed most in-person voices under one label, so attributions are reconstructed at the project level; quotations are faithful reconstructions, not verbatim records. External facts verified: program details (Flashbots X + IC3, May 18 – July 25, 2026), project surfaces (elizaos.ai, elocute.fun, bitrouter.ai, smithers.sh, tinycloud.xyz, teleport.best, getcontexto.com, daedalus-research.com), and Polymarket's first institutional block trade with FalconX (June 2, 2026, per CNBC). The full reconstructed text lives in the OS context vault as "WDYDLW Standup Recap June 8 2026."
