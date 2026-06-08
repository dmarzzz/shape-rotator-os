---
record_id: teesql
record_type: team
schema_version: 1
kind: team
membership: cohort

name: TeeSQL
focus: TEE Postgres on dstack
members_count: 2
geo: NYC / Estonia
domain: tee
shape: hex
is_mentor: false
links:
  github: TeeSQL
  x: null
  repo: https://github.com/orgs/TeeSQL/repositories
paper_basis:
  - Narrowing the Gap between TEEs Threat Model and Deployment Strategies
  - Persistent BitTorrent Trackers on dstack
traction: 4 open-source supporting repos · core private
now: hardening the RA-TLS proxy + onboarding cohort teams to TEE Postgres
success_dimensions:
  - productization
  - collaborative
prior_shipping:
  - attestation-report — open-source RA artifact tooling
  - ra-tls-parse, ra-tls-proxy, prisma-ra-tls (4 supporting repos)
  - Shopped to Phala + Flashbots; 2+ Flashbots-X projects need this today
skill_areas:
  - tee
  - dstack
  - confidential-db
  - attestation
dependencies:
  - abra
  - tinycloud
  - pramaana
  - crossroads
seeking:
  - cohort teams needing confidential SQL — let's bring you onto the beta
  - feedback on CVM provider deployment patterns
offering:
  - free TeeSQL service to cohort teams during the accelerator
  - open-source connection-layer attestation code
  - CVM provider market analysis sharing
journey:
  stage: 4
  evidence_quality: 3
  market_upside: 4
  primary_bottleneck: Technical Risk
  company_type: Infra
  confidence: Medium
  icp: teams that need confidential SQL with inspectable TEE deployment and RA-TLS connection guarantees
  problem: confidential applications need normal database ergonomics without silently losing the attestation and deployment guarantees
  solution: TEE Postgres on dstack plus RA-TLS proxy and open-source attestation connection tooling
  evidence_notes: multiple supporting repos, current beta direction, and clear cohort demand from other Flashbots-X projects; hardening remains the near-term risk
  next_milestone: onboard one cohort team to the TeeSQL beta and document the full attested connection path
making_signature:
  built_domain: [systems, agentic]
  shape: broad
  shared_primitives:
    - TEE attestation
    - consensus / BFT
    - zk / proof systems
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

_(public surface — see this team's PR or links above for more)_
