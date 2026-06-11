---
record_id: dealproof
record_type: team
schema_version: 1
kind: team
membership: visiting

name: DealProof
focus: TEE · PQ · dual-agent contracts
members_count: 1
geo: Rugby UK
domain: tee
shape: hex
is_mentor: false
links:
  github: kkoci/Dealproof
  x: kkoci80
  website: https://medium.com/@feeltech_kkoci
  demo: https://youtu.be/Dc6iVYAl9OU
  article: https://bit.ly/4tbAmJA
paper_basis:
  - NDAI Agreements
  - Props for ML Security
traction: Working Intel DCAP prototype · contributed to Quantinuum's guppylang
hackathon_note: Bradford Quantum Hackathon 2025 winner
now: negotiation app carries memory across rounds via Contexto; implementing PiCred provenance (arXiv:2606.03771); scoping a CVM API platform + first AI-negotiation outreach
graduation_target: "DealProof v2 live: ephemeral key generation inside TEE at boot, reproducible Docker builds with MRENCLAVE published on-chain, co-signing session parameters flow end-to-end. Agent-agnostic SDK drafted. At least one serious pilot conversation initiated with an enterprise or crypto-native counterparty."
monthly_milestones: |
  June: ephemeral keys at TEE boot, reproducible Docker build, MRENCLAVE on-chain, co-signing API spec
  July: co-signing frontend live, agent-agnostic framing documented, SDK draft, first external pilot conversation
weekly_goals: "Arrive NYC Monday, connect with Justin (ProvaTrust) on attestation layer complementarity, connect with dmarz on dstack/TEE pairing, explore Conclave collaboration (NDAI overlap), claim Shape Router profile"
success_dimensions:
  - productization
  - research_lineage
  - collaborative
prior_shipping:
  - DealProof — dual-agent attestation + on-chain escrow (56 passing tests)
  - confidential-agent-market hackathon repo
  - Quantum-classical contributor (guppylang) · Quantinuum
  - QuantumBrush 2.0 with Moth Quantum (presented AIPS + SXSW)
skill_areas:
  - tee
  - dstack
  - attestation
  - agentic
  - post-quantum
dependencies:
  - prova
  - conclave
  - signalstack
  - contexto
  - tinycloud
seeking:
  - cohort teams to integrate dual-attestation contract layer
  - feedback on DCAP verification UX for non-TEE-native developers
offering:
  - TEE/dstack deployment patterns (socket mounts, attestation, DCAP)
  - open-source dual-attestation library as cohort module
  - dealproof as AI-to-AI contract layer for cohort teams
journey:
  stage: 4
  evidence_quality: 2
  market_upside: 4
  primary_bottleneck: Technical Risk
  company_type: Protocol
  confidence: Low
  icp: agent builders who need verifiable AI-to-AI contracts with on-chain escrow
  problem: there's no trustworthy primitive for two autonomous agents to transact with attestable terms
  solution: dual-agent attestation layer (Intel DCAP) with on-chain escrow and a standalone open-source library
  evidence_notes: "working DCAP prototype with 56 passing tests; Bradford Quantum Hackathon 2025 winner; validated in demos but no external integrators yet. 2026-06-08 WDYDLW: integrated Contexto memory into CDN deal negotiations (hash + recall of prior terms); PiCred provenance (arXiv:2606.03771) underway with the paper's authors being introduced to the cohort; cold-reached two AI-negotiation companies (e.g. pactum.ai) to find the pain"
  next_milestone: turn the negotiation product + PiCred provenance into a CVM API-platform PoC and land the first external discovery conversation
making_signature:
  built_domain: [data]
  shape: broad
  shared_primitives:
    - TEE attestation
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

_(public surface — see this team's PR or links above for more)_
