---
record_id: signalstack
record_type: team
schema_version: 1
kind: team
membership: cohort

name: SignalStack
focus: TEE + LLM into Signal
members_count: 2
geo: NYC
domain: tee
shape: hex
is_mentor: false
links:
  github: RonTuretzky/sigstack
  x: null
  repo: RonTuretzky/sigstack
  slides: https://ronturetzky.github.io/sigstack-slides/
paper_basis: null
traction: Vitalik blog mention · prior at Lightblocks (Ittay Eyal lab, eoracle)
now: shipping the beta of confidential LLM inference on Intel TDX inside Signal
success_dimensions:
  - productization
  - collaborative
prior_shipping:
  - SignalStack — confidential LLM inference on Intel TDX (beta development)
  - SigStack public repo — Rust Signal bot, TEE attestation, and modular services
  - Vitalik Buterin acknowledgment in April 2026 secure-LLM blog post
skill_areas:
  - tee
  - dstack
  - agentic
  - attestation
dependencies:
  - prova
  - dealproof
  - conclave
seeking:
  - cohort teams comparing TEE deployment patterns + attestation UX
  - integration testers for the attestation verification SDK
offering:
  - TEE deployment workshop (setup, remote attestation, pitfalls)
  - open-source attestation verification SDK for cohort
  - AI tasks + AI translation features available to cohort via Signal
journey:
  stage: 4
  evidence_quality: 3
  market_upside: 4
  primary_bottleneck: Solution Quality
  company_type: AI
  confidence: Medium
  icp: Signal users and privacy-sensitive teams that want AI assistance without moving private messages into a hosted AI app
  problem: mainstream AI tools require users to leave private messaging contexts and trust servers with sensitive prompts
  solution: confidential LLM inference inside Signal with TEE attestation and zero-retention workflow primitives
  evidence_notes: public sigstack repo, beta-development surface, attestation SDK, and privacy-AI market framing are present; repeated user adoption remains to prove
  next_milestone: onboard real Signal users or cohort teams to test translation, summarization, and assistant workflows
making_signature:
  built_domain: [systems]
  shape: deep
  shared_primitives:
    - zk / proof systems
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

_(public surface — see this team's PR or links above for more)_
