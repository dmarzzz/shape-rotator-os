---
record_id: conclave-contexto
record_type: dependency
schema_version: 1
source: conclave
target: contexto
relation: depends_on
status: declared
confidence: medium
reason: Conclave's confidential-signal pipeline needs long-horizon memory (keeping early-cohort signal relevant weeks later), which is exactly Contexto's relevant-subtree context-injection capability; both teams already list each other as dependencies.
evidence:
  - "Conclave focus: NDAI framework · skills runtime; offering: modular skill framework for TEE-agent projects"
  - "Conclave already lists contexto in its declared dependencies"
  - "Contexto focus: agent context engine; offering: a context engine / relevant-context injection layer other cohort agents can build on"
  - "Contexto already lists conclave in its declared dependencies"
  - "Shared skill areas: agentic, agent-runtime"
next_action: Scope a thin spike where Conclave's multi-week derived-signal pipeline indexes its exhaust through Contexto and pulls only the relevant subtree at signal-emit time.
updated_at: 2026-06-14
---

## source

Collaboration candidate, not a hard dependency claim. Both teams' public profiles already declare the link; the directional need-to-capability read (long-horizon pipeline memory ← context engine) was surfaced in reviewed cohort session notes and is grounded here only in source-visible public team fields. No integration work is confirmed yet.
