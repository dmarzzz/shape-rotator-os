---
record_id: trustless-tee
record_type: team
schema_version: 1
kind: project
membership: visiting

# surface fields (visible to all participants)
name: Trustless TEE
focus: trustless trusted-execution
members_count: 1
geo: null
domain: tee
shape: hex
is_mentor: false
links:
  github: null
  x: 0xQuintus
  website: null
  demo: null
  deck: null
paper_basis: null
traction: null
hackathon_note: null
now: clarifying the TEE trust-root problem rather than treating vendor signing keys as invisible infrastructure
success_dimensions:
  - research_lineage
  - collaborative
skill_areas:
  - tee
  - attestation
  - mechanism-design
dependencies:
  - signalstack
  - prova
  - dealproof
seeking:
  - TEE builders to pressure-test where trust actually enters their stack
  - protocol reviewers who can separate enclave proof from hardware-root trust
offering:
  - sharp trust-boundary review for TEE-based projects
  - Ethereum execution context around latency, sequencing, and priority updates
journey:
  stage: 2
  evidence_quality: 1
  market_upside: 3
  primary_bottleneck: Technical Risk
  company_type: Infra
  confidence: Low
  icp: TEE protocol builders who need a clearer answer to the vendor-key trust assumption
  problem: confidential-compute designs can inherit a hidden trust root from Intel/AMD signing keys even when the rest of the protocol is trust-minimized
  solution: make that trust root explicit and explore a trustless or less-vendor-dependent TEE design
  evidence_notes: public profile and OSINT establish the trust-root thesis; implementation surface is not yet visible in the cohort data
  next_milestone: publish or demo the minimum concrete trust-root alternative the cohort can inspect
---

## about

Trustless trusted-execution. Addresses the trust-root problem that confidential-compute systems inherit — the hardware vendor's signing key — rather than treating it as a given.
