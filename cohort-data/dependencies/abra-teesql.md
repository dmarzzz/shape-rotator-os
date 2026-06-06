---
record_id: abra-teesql
record_type: dependency
schema_version: 1
source: abra
target: teesql
relation: depends_on
status: exploring
confidence: medium
reason: Abra is building a formal-verification registry around dstack TEE Postgres and explicitly asks for TEE Postgres beta access; TeeSQL is the cohort team offering TEE Postgres service and onboarding.
evidence:
  - "Abra focus: formal verification · dstack TEE Postgres"
  - "Abra seeking: TEE Postgres beta access for the verification registry"
  - "TeeSQL focus: TEE Postgres on dstack"
  - "TeeSQL offering: free TeeSQL service to cohort teams during the accelerator"
next_action: Confirm whether Abra's verification registry should use TeeSQL beta access or only compare implementation patterns.
updated_at: 2026-06-05
---

## source

This is typed as an exploring dependency because Abra names a concrete TeeSQL-shaped need, while TeeSQL offers the matching service to cohort teams.
