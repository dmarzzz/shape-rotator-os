---
record_id: dcnet
record_type: team
schema_version: 1
kind: project
membership: visiting

# surface fields (visible to all participants)
name: DCNet
focus: dining-cryptographer-style anonymity network
members_count: 3
geo: null
domain: crypto
shape: torus
is_mentor: false
links:
  github: null
  repo: null
  x: null
  website: null
  demo: null
  deck: null
paper_basis: null
traction: null
hackathon_note: null
now: exploring DCNet anonymous-broadcast designs for blockchain coordination and private web search
success_dimensions:
  - research_lineage
  - collaborative
skill_areas:
  - p2p
  - identity
  - mechanism-design
  - zk
dependencies:
  - searxng-wth-frnds
  - teleport-router
  - crossroads
seeking:
  - protocol reviewers for dining-cryptographer-style anonymity tradeoffs
  - product collaborators who can pressure-test private-search and blockchain use cases
offering:
  - anonymity-network design review
  - private broadcast primitives for cohort projects that need coordination without attribution leakage
journey:
  stage: 2
  evidence_quality: 1
  market_upside: 3
  primary_bottleneck: Technical Risk
  company_type: Protocol
  confidence: Low
  icp: protocol builders who need anonymous broadcast or private group coordination
  problem: useful coordination often reveals who spoke, searched, or initiated a message even when payloads are encrypted
  solution: productize DCNet-style anonymous broadcast for blockchain and private-search settings
  evidence_notes: current app and vault surface establish the project thesis and members; primary project application/repo evidence is still sparse
  next_milestone: publish a minimal architecture note or demo showing the anonymity/scalability tradeoff
making_signature:
  built_domain: [systems]
  shape: deep
  shared_primitives:
    - consensus / BFT
    - verifiable crypto identity
    - zk / proof systems
  note: "derived from the team's public code (structure + cross-cohort shared primitives), not a self-claim"
  source: code-derived
---

## about

DCNets, _Dining Cryptographers Networks_, are overlay networking protocols for _anonymous broadcast_ of messages. Multiple promising architectures have been proposed, with varying tradeoffs for scalability and trust. This team will explore the state-of-the-art and productization of the technology, with applications to blockchains and private web search.
