---
record_id: ron-turetzky
record_type: person
schema_version: 1
name: Ron Turetzky
team: signalstack
role: lead
role_class: cohort-member
geo: null
domain: null
dates_start: 2026-05-25
dates_end: 2026-07-25
links:
  github: RonTuretzky
  x: RonTuretzky
  website: null
  linkedin: null
now: shipping confidential LLM inference inside Signal with TEE attestation
skill_areas:
  - tee
  - dstack
  - attestation
  - agentic
go_to_them_for:
  - private agent messaging
  - TEE/LLM integration
  - Signal-style workflows
  - security-boundary questions
recurring_themes:
  - trusted communication
  - privacy constraints
  - agent usefulness inside chat
  - sparse-source review needed
working_style: "product-surface-first TEE builder: put private inference inside existing messenger behavior before asking users to learn a new app"
best_contexts:
  - TEE attestation architecture reviews
  - privacy-sensitive AI product flows
  - Signal-native workflow and bot design
prior_work:
  - SigStack — private AI services on Signal, powered by TEEs
  - public sigstack repo across Rust, Docker, web, and attestation surfaces
  - Lightblocks / IC3-adjacent TEE and oracle lineage
enrichment_source: dossier-derived  # facilitator read; edit freely
---

## about

Lead of SignalStack — confidential LLM inference run on Intel TDX and surfaced inside Signal the messenger, plus an attestation-verification SDK offered to the cohort. The thesis: put verifiable private inference where users already are, rather than build a new app surface. Lineage in the IC3-adjacent TEE/oracle scene (Lightblocks, Ittay Eyal's lab, eoracle).
