---
record_id: tinycloud-teesql
record_type: dependency
schema_version: 1
source: tinycloud
target: teesql
relation: shares_substrate
status: exploring
confidence: medium
reason: Tinycloud and TeeSQL both operate around dstack TEEs, scoped delegation, confidential infrastructure, and cohort-facing services, but the current public records support substrate overlap rather than a confirmed product dependency.
evidence:
  - "Tinycloud focus: user-owned cloud, dstack TEEs"
  - "Tinycloud offering: tinycloud-secrets for cohort teams"
  - "TeeSQL focus: TEE Postgres on dstack"
  - "TeeSQL offering: open-source connection-layer attestation code"
  - "Shared skill areas: tee, dstack, attestation"
next_action: Determine whether Tinycloud secrets/delegation and TeeSQL confidential storage should integrate, or whether this remains a deployment-pattern comparison.
updated_at: 2026-06-05
---

## source

This record encodes shared substrate only. It should not be read as a hard dependency until the teams confirm an integration.
