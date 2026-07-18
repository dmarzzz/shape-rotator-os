---
record_id: teesql
record_type: team
schema_version: 1
kind: team
membership: cohort

name: Synclave
focus: confidential-compute platform for hosted apps, attestable agent sandboxes, and high-availability
members_count: 3
geo: NYC / Estonia / UK
domain: tee
shape: hex
is_mentor: false
links:
  github: AttestMesh
  x: null
  repo: https://github.com/orgs/AttestMesh/repositories
paper_basis:
  - Narrowing the Gap between TEEs Threat Model and Deployment Strategies
  - Persistent BitTorrent Trackers on dstack
traction: 4 open-source supporting repos · core private
now: productizing confidential compute through hosted apps and attestable agent sandboxes while integrating self-service HA Mesh with the existing AttestMesh v1 control plane — validating the strongest off-cohort ICP and preparing for broader production use
success_dimensions:
  - productization
  - collaborative
prior_shipping:
  - attestation-report — open-source RA artifact tooling
  - ra-tls-parse, ra-tls-proxy, prisma-ra-tls (4 supporting repos)
  - Shopped to Phala + Flashbots; multiple Flashbots X-adjacent projects need this today
  - TeeSQL — attested Postgres foundation that evolved into the broader Synclave platform
skill_areas:
  - tee
  - dstack
  - confidential-compute
  - attestation
dependencies:
  - abra
  - tinycloud
  - pramaana
  - crossroads
seeking:
  - cohort teams needing private, attestable hosting or agent infrastructure — let's deploy your workload on Synclave
  - feedback on hosted-app, agent-sandbox, and dedicated-CVM deployment patterns
offering:
  - free Synclave service to cohort teams during the accelerator
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
  evidence_notes: "multiple supporting repos, current beta direction, and clear cohort demand from Flashbots X-adjacent projects. 2026-06-08 WDYDLW: product-shape pivot from HA Postgres cluster to generalized attestation-gated mesh; candid self-assessment — 'nothing fundamentally defensible yet'; bottleneck migrating from technical risk toward ICP clarity and a moat"
  next_milestone: deploy a high-value external application or agent workload on Synclave, convert its trust requirements into repeatable product evidence, and carry one cohort team through an end-to-end attested deployment
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
