---
record_id: searxng-wth-frnds
record_type: team
schema_version: 1
kind: project
membership: visiting

# surface fields (visible to all participants)
name: searxng-wth-frnds
focus: LAN-first peer search daemon
members_count: 1
geo: NYC
domain: crypto
shape: torus
is_mentor: false
links:
  github: dmarzzz/searxng-wth-frnds
  repo: dmarzzz/searxng-wth-frnds
  x: null
  website: null
  demo: null
  deck: null
paper_basis: null
traction: null
hackathon_note: null
now: turning SearXNG into a LAN-first local search surface for trusted peers
success_dimensions:
  - productization
  - collaborative
prior_shipping:
  - searxng-wth-frnds — SearXNG-based LAN-first peer search daemon
skill_areas:
  - p2p
  - identity
  - bd-gtm
dependencies:
  - dcnet
  - contexto
seeking:
  - cohort peers who want private/local search over trusted shared context
  - feedback on what should stay local, what should sync, and what should never leave the LAN
offering:
  - local-first search patterns for cohort tools
  - practical privacy defaults for small trusted groups
journey:
  stage: 2
  evidence_quality: 2
  market_upside: 3
  primary_bottleneck: ICP Clarity
  company_type: Infra
  confidence: Low
  icp: small trusted groups that need private shared search without a hosted search backend
  problem: useful group search often leaks private queries, sources, or social context into centralized infrastructure
  solution: a LAN-first peer search daemon built around SearXNG and trusted local peers
  evidence_notes: public repository and coordinator source profile establish the product direction; cohort dogfooding still needs sharper user stories
  next_milestone: get one cohort workflow using the LAN search surface for real retrieval
making_signature:
  built_domain: [data]
  shape: deep
  shared_primitives:
    - verifiable crypto identity
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

A LAN-first peer search daemon — local-first, privacy-by-default search shared across a local network of trusted peers. Built on the SearXNG metasearch engine.
