---
record_id: tinycloud
record_type: team
schema_version: 1
kind: team
membership: cohort

name: Tinycloud
focus: user-owned cloud, dstack TEEs
members_count: 4
geo: NYC / Berlin / Lisbon
domain: tee
shape: hex
is_mentor: false
links:
  github: TinyCloudLabs
  x: null
  website: https://tinycloud.xyz
  deck: https://tinycloud.xyz/deck
paper_basis:
  - Thetacrypt (threshold cryptography for delegation)
  - Anonymous Self-Credentials / SD-JWT
  - Narrowing the Gap between TEEs Threat Model and Deployment Strategies
traction: Live SDK + protocol · paid pilot with Sparq Gaming · Sam ex-SpruceID
now: open-sourcing the delegation stack for cohort use
success_dimensions:
  - productization
  - research_lineage
  - collaborative
prior_shipping:
  - tinycloud-node SDK (Rust + TypeScript)
  - tinycloud-dstack — TEE attestation fork
  - Muse — AI memory bank (Edge Esmeralda 2025 residency)
  - Realtime audio transcriber (shipped with Etherea)
skill_areas:
  - tee
  - dstack
  - threshold-crypto
  - attestation
  - identity
dependencies:
  - teesql
  - etherea
  - conclave
seeking:
  - cohort teams to dogfood tinycloud-secrets (scoped credential delegation)
  - design feedback on the agentic collaboration platform
offering:
  - tinycloud-secrets for cohort teams (scoped credential delegation for agents)
  - cryptographic engineering pair on threshold + proxy re-encryption
journey:
  stage: 4
  evidence_quality: 3
  market_upside: 4
  primary_bottleneck: ICP Clarity
  company_type: Infra
  confidence: Medium
  icp: agent builders who need user-owned cloud execution and scoped credential delegation inside TEE-backed infrastructure
  problem: users and agents need to delegate secrets or cloud actions without giving broad account control to opaque services
  solution: user-owned cloud and tinycloud-secrets for scoped credential delegation on dstack/TEE rails
  evidence_notes: live SDK/protocol, paid pilot, dstack fork, and shipped related tools show execution; product wedge should narrow around cohort dogfooders
  next_milestone: get one cohort project using tinycloud-secrets for a real scoped delegation workflow
making_signature:
  built_domain: [agentic, systems]
  shape: broad
  shared_primitives:
    - TEE attestation
    - verifiable crypto identity
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

_(public surface — see this team's PR or links above for more)_
