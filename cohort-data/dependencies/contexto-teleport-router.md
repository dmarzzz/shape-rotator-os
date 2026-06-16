---
record_id: contexto-teleport-router
record_type: dependency
schema_version: 1
source: contexto
target: teleport-router
relation: complements
status: exploring
confidence: medium
reason: Contexto (ingest long-horizon context) and Teleport Router (ambient cross-pollination feed) are adjacent stages of the same goal — removing manual prompt relay between collaborators' agents; Teleport Router already lists contexto as a dependency.
evidence:
  - "Contexto focus: agent context engine; roadmap: one person's agent calling another's exposed workflow endpoint instead of copy-pasting prompts"
  - "Teleport Router focus: cross-network routing; offering: routing primitives and an in-session cross-pollination feed"
  - "Teleport Router already lists contexto in its declared dependencies"
  - "Shared skill areas: agentic / agent-routing"
next_action: Test whether Router feed signals can feed Contexto's relevance index (or vice versa) as a concrete interface; downgrade to a weak co-topic link if neither team pursues an integration.
updated_at: 2026-06-14
---

## source

Complementary-stage relationship grounded in source-visible public team fields (Teleport Router's declared dependency on contexto plus both teams' agent-routing focus). The "compose into one agent stack" framing was surfaced in reviewed cohort session notes; treat it as editorial motivation, not a confirmed integration.
