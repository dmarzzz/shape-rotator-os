---
vault_id: teleport-router-onboarding-2026-05-27
date: 2026-05-27
title: "Teleport Router Onboarding & Privacy Boundaries"
kind: workshop
consent: cohort-internal
teams: [teleport-router, shape-rotator-os]
people: [andrew-miller, james-barnes, gonzo-gelso]
source: private-vault:teleport-router-onboarding-2026-05-27
---

# Teleport Router Onboarding & Privacy Boundaries

**Onboarding is the router's real product surface.**

*An onboarding clinic for linking agents to the cohort router, the agent-drafted self-introduction notebook, and the privacy-boundary question that auto-generated intros raise.*

## the 60-second version

The session walked the cohort through linking their agents to the Teleport Router: an agent crawls your projects to draft a self-introduction you review and publish into a shared notebook, with Matrix as the interface and a code handshake to link accounts. The sharpest moment was a privacy-boundary question — if the notebook publishes the topics you said you didn't want to discuss, it may be teaching others your boundaries rather than keeping them private — flagged as an open decision before everyone links their work contexts together.

## themes

- Agent onboarding as the real adoption bottleneck
- Privacy boundaries in auto-generated self-introductions
- Matrix as the cohort interface to a shared notebook
- Ambient cross-pollination via router auto-commenting

## insights

- The self-introduction pipeline has an agent crawl your projects and propose a self-intro you review, clean, and publish into a shared notebook, rather than relying only on the current session's context.
- A privacy-boundary tension surfaced: auto-generated intros listed individual topics the author did not want to discuss, so publishing them to the notebook could teach others those boundaries instead of keeping them as a private meta-note — an open design question before everyone links contexts.
- The stack is three layers — the router server, the Hermes agent that makes connections, and the Matrix server as the cohort-facing interface — with notebook entries exposed to a search tool the bot can query.
- The router can comment on people's posts when an entry is relevant to someone else, turning the shared notebook into an ambient cross-pollination feed rather than a passive archive.
- Account linking is a simple code-exchange handshake: message the bot, then send the returned code back to your agent to link your Matrix account to your router account.
- Onboarding sessions themselves are the adoption lever — early hesitancy traced mostly to people not understanding what the router was — and the feed is a plain REST API, so the Shape Rotator OS can consume it directly.

## q&a

**Q: How active is the cohort on the Matrix server, given the onboarding hesitancy people mentioned?**

The hesitancy traced mostly to people not understanding what the router did rather than rejecting it; dedicated onboarding sessions are the fix, and a couple were run that week.

**Q: Should the notebook publish a person's stated privacy boundaries?**

Open question — auto-generated self-intros listed topics the author didn't want to discuss, which the author had to clean by hand; the group flagged it as a decision to settle before linking everyone's contexts.

**Q: Can the Shape Rotator OS consume the notebook feed?**

Yes — it's a simple REST API, so the OS can read the shared feed directly rather than reimplementing the pipeline.


## references

- [Matrix (cohort interface)](https://matrix.org)
- [Teleport Router](https://teleport.best)

## provenance

Distilled from a private-vault transcript (`teleport-router-onboarding-2026-05-27`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `cohort-internal`.
