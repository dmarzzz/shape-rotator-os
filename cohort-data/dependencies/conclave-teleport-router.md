---
record_id: conclave-teleport-router
record_type: dependency
schema_version: 1
source: conclave
target: teleport-router
relation: shares_substrate
status: declared
confidence: medium
reason: Conclave and Teleport Router build on the same substrate — an open-source, policy-enforcing agent running inside a TEE that processes private data from mutually-distrusting parties and emits only scoped, derived output — applied to organizer-signal mining vs ambient session routing.
evidence:
  - "Conclave skill areas: tee, dstack, agentic, agent-runtime; offering: a modular skill framework run open-source in a TEE"
  - "Teleport Router skill areas: attestation, agent-routing; offering: TEE-hosted routing primitives with policy enforcement"
  - "Both run policy-enforcing agents inside TEEs over mutually-distrusting members' data, emitting only scoped derived output"
next_action: Confirm whether the two could share a concrete TEE/attestation stack or a scoped-output-policy framework; a shared enclave/attestation layer or policy schema would upgrade this toward pairs_with.
updated_at: 2026-06-14
---

## source

Shared-substrate relationship (parallel architecture, not a confirmed dependency) grounded in both teams' public TEE/attestation skill areas and offerings. The common pattern was surfaced in reviewed cohort session notes; no integration or dogfooding between the two is asserted.
