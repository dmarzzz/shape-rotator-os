---
record_id: bitrouter-teesql
record_type: dependency
schema_version: 1
source: bitrouter
target: teesql
relation: shares_substrate
status: exploring
confidence: medium
reason: Bitrouter and TeeSQL both lean on TEE remote attestation as an admission/trust primitive that displaces reputation — Bitrouter for permissionless LLM-provider onboarding, TeeSQL for attestation-gated cluster membership.
evidence:
  - "Bitrouter focus: P2P LLM router; supply formed over the Phala (dstack) network"
  - "TeeSQL focus: attestation-gated mesh for open-source workloads; skill areas: tee, dstack, attestation"
  - "TeeSQL offering: open-source connection-layer attestation code"
  - "Both treat cryptographic attestation as a stronger trust basis than reputation for permissionless participants"
next_action: Confirm whether both would use the same attestation/measurement scheme (shared quote verification or a common attestation registry); if so, upgrade from a parallel-substrate signal to a concrete integration edge.
updated_at: 2026-06-14
---

## source

Shared-substrate signal (thematic-but-concrete attestation convergence, no confirmed interaction) grounded in both teams' public dstack/attestation focus and offerings. Surfaced in reviewed cohort session notes; held at exploring/medium because the public records show parallel use of attestation, not a built integration.
