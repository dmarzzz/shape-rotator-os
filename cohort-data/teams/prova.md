---
record_id: prova
record_type: team
schema_version: 1
kind: team
membership: cohort

name: Prova
focus: healthcare AI agents · EHR pilot
members_count: 1
geo: St. Louis
domain: ai
shape: prism
is_mentor: false
links:
  github: null
  x: null
  website: https://health.provatrust.com/
  demo: https://www.loom.com/share/56f76b67a8374a6aa745f02ee4ce3945
  deck: https://www.provatrust.com/ic3-deck
paper_basis:
  - Props (MPC-TLS data provenance)
  - dstack (Intel TDX attestation)
  - NDAI Agreements
  - U2SSO / Anonymous Self-Credentials
  - Conditional Recall
  - Thetacrypt
  - Narrowing the Gap between TEEs Threat Model and Deployment Strategies
traction: Live on Phala TDX · 2x prior founder
hackathon_note: 1st place TEE track · Shape Rotator Hackathon
now: hardening the dual-attestation library for cohort reuse
success_dimensions:
  - productization
  - research_lineage
  - collaborative
prior_shipping:
  - Production live on Phala TDX (stable uptime since hackathon)
  - 1st place Shape Rotator Hackathon · TEE track
  - health.provatrust.com demo (healthcare prior-auth workflow)
  - Working payer integrations (Da Vinci PAS, X12 278)
skill_areas:
  - tee
  - dstack
  - attestation
  - agentic
  - threshold-crypto
dependencies:
  - dealproof
  - signalstack
  - conclave
  - teesql
seeking:
  - cohort teams shipping LLM inference in TEEs to compare deployment patterns
  - integration partners for the trust-api attestation layer
offering:
  - TEE-deployment workshop (docker compose, dstack secrets, async patterns)
  - dual-attestation library — open-sourced for cohort reuse
  - prova trust-api as free attestation layer for other cohort teams
journey:
  stage: 5
  evidence_quality: 3
  market_upside: 5
  primary_bottleneck: GTM
  company_type: B2B
  confidence: Medium
  icp: regional payers + provider groups drowning in prior-auth volume
  problem: prior-authorization is a manual, multi-day fax-and-phone slog that delays care and burns clinical staff time
  solution: TEE-attested healthcare AI agent that runs the prior-auth workflow end-to-end against payer EHR integrations
  evidence_notes: live on Phala TDX with stable uptime since hackathon; working Da Vinci PAS / X12 278 payer integrations; founder has 2x prior exits
  next_milestone: convert the active EHR pilot into a signed paid design-partner contract
---

## about

_(public surface — see this team's PR or links above for more)_
