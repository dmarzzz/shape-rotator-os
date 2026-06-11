---
record_id: daedalus
record_type: team
schema_version: 1
kind: team
membership: cohort

# surface fields
name: Daedalus
focus: prediction market microstructure research
members_count: 3
geo: distributed (NYC / SF / Asia)
domain: crypto
shape: torus
is_mentor: false
links:
  github: null
  repo: null
  x: null
  website: daedalus-research.com
  demo: null
  deck: null
paper_basis:
  - PROF — Protected Order Flow in a Profit-Seeking World (arXiv 2510.15205)
traction: Cornell Tech / ex-Aptos / Jane Street
hackathon_note: null
now: scraping Polymarket L2/L3 orderbook history to backtest delta-neutral stock-portfolio hedges — new demo targeted by end of next week
success_dimensions:
  - research_lineage
  - productization
prior_shipping:
  - PROF paper (arXiv 2510.15205) — protected order flow mechanism design
  - Real market data + live trading validation in progress
skill_areas:
  - mev
  - mechanism-design
  - research-to-product
dependencies:
  - bitrouter
  - crossroads
seeking:
  - feedback from cohort teams building trading or agent execution systems
  - integration partners for protected order flow primitives
offering:
  - market microstructure learnings (toxic flow handling, latency, orderbook dynamics)
  - open data + evaluation pipeline (orderbook ingestion, backtesting)
journey:
  stage: 2
  evidence_quality: 2
  market_upside: 4
  primary_bottleneck: ICP Clarity
  company_type: Infra
  confidence: Low
  icp: systematic prediction-market traders and infrastructure builders who need protected order-flow evaluation
  problem: prediction-market liquidity and execution quality are constrained by toxic flow, latency, and weak microstructure tooling
  solution: a discovery tool for delta-neutral hedges (Polymarket + sports events vs stock portfolios) — intelligence, not execution; gated on rigorous correlation backtesting before any app is built
  evidence_notes: "PROF paper and market-data pipeline direction are credible; customer/user pull is not yet proven. 2026-06-08 WDYDLW: de-risked from a make-users-money bot (fiduciary/broker-dealer exposure) toward hedge discovery per Shaw's steer; institutionalization signal — Polymarket's first institutional block trade (FalconX, June 2, 2026); the core correlation is still unproven"
  next_milestone: show one correlation backtest that validates (or kills) the delta-neutral hedge thesis — demo targeted by 2026-06-19
---

## about

Prediction-market microstructure research — a liquidity-and-intelligence engine for prediction markets and InfoFi. Building AI-powered market-making infrastructure that combines predictive intelligence, calibrated belief models, and systematic execution into a unified data, risk, and execution layer for institutional and systematic traders. Research lineage in the PROF paper (IC3). daedalus-research.com.
