---
record_id: teleport-router
record_type: team
schema_version: 1
kind: project
membership: cohort

# surface fields (visible to all participants)
name: Teleport Router
focus: cross-network routing
members_count: 2
geo: null
domain: crypto
shape: meridian
is_mentor: false
links:
  github: null
  repo: https://github.com/jameslbarnes/teleport-router
  x: null
  website: https://teleport.best
  demo: null
  deck: null
paper_basis: null
traction: null
hackathon_note: null
now: turning one-time delegated posting into a clearer cross-network routing and attestation primitive
success_dimensions:
  - productization
  - research_lineage
  - collaborative
prior_shipping:
  - teleport.best — one-time-use delegated posting surface
  - teleport-router public repo
skill_areas:
  - cross-chain
  - identity
  - attestation
  - agent-routing
dependencies:
  - dcnet
  - feedling
  - contexto
  - crossroads
seeking:
  - teams that need delegated posting, cross-network routing, or social account handoff
  - reviewers for attestation-verified delegation flows
offering:
  - one-time delegation and routing primitives
  - social/account-boundary experiments for projects with user-owned context
journey:
  stage: 3
  evidence_quality: 2
  market_upside: 4
  primary_bottleneck: Solution Quality
  company_type: Protocol
  confidence: Low
  icp: builders who need temporary delegated control across social or network surfaces without giving away account custody
  problem: routing actions across accounts/networks often requires either full custody transfer or brittle manual coordination
  solution: one-time-use delegated posting and attestation-verified routing primitives
  evidence_notes: public surface and repo establish the delegation direction; cohort still needs a concrete integration target
  next_milestone: land one real cohort use case where another project delegates or routes an action through Teleport
making_signature:
  built_domain: [agentic]
  shape: broad
  shared_primitives:
    - zk / proof systems
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

Cross-network routing in the TEE/attestation space. The public surface (teleport.best) offers one-time-use delegated posting — let someone post to your account once without handing over control — with related work on attestation-verified delegation.
