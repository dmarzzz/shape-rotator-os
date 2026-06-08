---
record_id: enclave
record_type: team
schema_version: 1
kind: team
membership: visiting

# surface fields
name: Enclave
focus: TEE-enabled medical data sharing
members_count: 1
geo: Toronto (valid US visa)
domain: tee
shape: hex
is_mentor: false
links:
  github: khushidahi
  repo: null
  x: null
  website: enclave-demo.onrender.com
  demo: null
  deck: null
paper_basis: null
traction: UWaterloo CS · Dayforce ML Engineer (7M+ users)
hackathon_note: null
now: shaping a TEE-backed medical-data sharing prototype around concrete trust-boundary and compliance workflows
success_dimensions:
  - productization
  - research_lineage
skill_areas:
  - tee
  - confidential-db
  - attestation
dependencies:
  - teesql
  - signalstack
  - dealproof
seeking:
  - healthcare or regulated-data users who can validate the first workflow
  - TEE reviewers for medical-data threat modeling
offering:
  - applied ML/product perspective for sensitive-data workflows
  - regulated-data use cases for TEE infrastructure teams
journey:
  stage: 2
  evidence_quality: 1
  market_upside: 4
  primary_bottleneck: ICP Clarity
  company_type: B2B
  confidence: Low
  icp: healthcare teams that need to collaborate on sensitive medical data without exposing the raw data
  problem: medical data is valuable for coordination and analysis but hard to share across trust boundaries
  solution: TEE-enabled medical-data exchange where sensitive inputs can be used without being exposed
  evidence_notes: current app surface establishes focus and builder background, but the vault lacks primary project application/repo evidence
  next_milestone: identify one concrete medical-data sharing workflow and demo the trust boundary end to end
making_signature:
  built_domain: [data]
  shape: deep
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

TEE-enabled medical data sharing — confidential compute for exchanging sensitive medical data across stronger trust boundaries, so the data can be used without being exposed.
