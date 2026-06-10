---
record_id: teesql
record_type: team
schema_version: 1
kind: team
membership: cohort

name: TeeSQL
focus: attestation-gated mesh for open-source workloads · TEE Postgres on dstack
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
now: generalizing from TEE Postgres to an attestation-gated mesh for any open-source workload (Clickhouse, Redis) — hunting an off-cohort ICP in European confidential-computing enterprise
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
  primary_bottleneck: ICP Clarity
  company_type: Infra
  confidence: Medium
  icp: European confidential-computing enterprises reducing US-cloud reliance (reached via web2 enterprise networks), alongside teams needing confidential SQL with attested connections
  problem: confidential applications need normal database ergonomics without silently losing the attestation and deployment guarantees
  solution: a generalized attestation-gated mesh that can run any open-source software (Postgres, Clickhouse, Redis) with a blockchain control plane and host- or dev-proof modes
  evidence_notes: "multiple supporting repos, current beta direction, and clear cohort demand from other Flashbots-X projects. 2026-06-08 WDYDLW: product-shape pivot from HA Postgres cluster to generalized attestation-gated mesh; candid self-assessment — 'nothing fundamentally defensible yet'; bottleneck migrating from technical risk toward ICP clarity and a moat"
  next_milestone: open the first European confidential-computing enterprise conversation while keeping one cohort team on the attested beta path
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
