---
vault_id: project-intros-local-private-first-phil-2026-05-20
date: 2026-05-20
title: "Project Intros: Local/Private-First Architectures + Founder Journey Segment"
kind: intros
consent: speaker-pending
teams: [pramaana, tinycloud, bitrouter, teesql, signalstack]
people: [andrew-miller, dmarz, sri, rajat-verma, sam-gbafa, hunter-horsfall, patrick-messall, roman-svistel, kelsen-liu, lsdan, kristel-alliksaar, hudson, ron-turetzky, james-barnes, albiona-hoti, gonzo-gelso]
source: private-vault:project-intros-local-private-first-phil-2026-05-20
---

# Project Intros: Local/Private-First Architectures + Founder Journey Segment

**Privacy only matters when it unlocks a capability someone already wants.**

*Five cohort teams presented local-first and private-first systems — no-retention identity, sovereign data spaces, open agent routing, enclave databases, and private messenger bots — followed by a thematic founder conversation on AI, art, and emotionally engaging experiences.*

## the 60-second version

Five teams presented local-first and private-first systems — no-retention identity, sovereign data spaces, open model routing, enclave databases, and private-messenger AI — with TEEs recurring as the trust primitive that lets users hand data to computation without handing it to a counterparty. A founder-journey segment closed the room on whether AI can make art, treated as an empirical design question rather than a slogan.

## themes

- Local-first and private-first system architectures
- TEE attestation as a trust primitive beyond reputation
- Identity and verification without data retention
- Designing emotionally engaging, privacy-preserving AI experiences

## insights

- Derive-then-destroy identity: one team demonstrated turning verified government-ID data into one-time deterministic entropy — hash, key derivation, then post-quantum (Kyber/ML-KEM) keypair generation — publishing only a commitment on chain and erasing the source data, so each service sees an unlinkable per-service pseudonym and only the user-held master key can connect them.
- The unresolved core of no-storage identity is sybil resistance: group discussion converged on the point that destroying data after verification does not stop enrollment with stolen identifiers, pushing the design toward document-authenticity checks, biometrics-as-entropy, and TEE-based verification instead of retained databases.
- Data asymmetry as a product thesis: privacy was framed as selectively maintaining information asymmetry while still gaining AI capabilities, with TEEs as the mechanism that lets users hand data to computation without handing it to a counterparty.
- Signature-rooted capability chains enable interoperable apps: a single user key creates a data space and delegates scoped, human-and-machine-readable permissions to apps, backends, and agents; combined with a common identity, a shared data location, per-app manifests, and discoverability, agents can assemble ad-hoc applications (e.g., two narrow trackers plus a correlation agent) without rigid interop standards.
- Threshold encryption for delegated sharing: data is encrypted to a user-controlled network of nodes that each produce partial decryptions only under a signed permission chain, so encrypted content can be shared with people or agents without any single decrypting custodian.
- Agentic LLM routing priorities: an open-source gateway argued the four requirements for agent traffic are reliability (failover), observability, security, and cost-efficiency; intelligent failover must price in cache loss when switching providers, and permissionless provider onboarding ultimately needs cryptographic attestation because reputation rarely produces clear evidence of data misuse.
- Dev-proof managed infrastructure: a Postgres-in-confidential-VM cluster routes every control signal through a smart contract, gates cluster membership on attestation measurements, encrypts replication and backups inside enclaves, and turns any human access into a publicly visible break-glass event — extending TEE guarantees from compute to databases at near-commodity managed pricing.
- The founder-journey segment treated whether AI can make art as an empirical design question: build LLM-native game loops where a second model evaluates open-ended conversation against hidden progression conditions, judge success by whether people genuinely feel something, and recognize that emotionally revealing AI experiences both answer the question and motivate privacy-preserving inference — with consent and upfront disclosure as first-class design constraints for immersive experiences.

## q&a

**Q: Can an identity system verify a person without storing their documents?**

The presented pattern verifies a government ID once (potentially inside a TEE), uses it as deterministic entropy to derive post-quantum keys, publishes only a hashed commitment, and erases the source data, so later authentication never replays or stores the underlying identifiers.

**Q: What stops someone from enrolling with a stolen identifier in a derive-then-destroy identity system?**

Deletion after verification does not prevent fraudulent enrollment, so the team is exploring document-authenticity analysis, biometric signals as additional entropy, and enclave-backed verification to bind one real person to one credential — acknowledged in discussion as the open hard problem.

**Q: Where does data actually live in a sovereign data-space system, and how censorship-resistant is it?**

Users can self-host nodes and even their own node registry for full sovereignty; the hosted offering runs nodes in TEEs, cannot decrypt user content, and positions the operator as a data fiduciary that complies with legal orders — sovereignty for those who want it, compliance for the managed path.

**Q: How can users verify that a model-routing gateway really serves the model it claims?**

Either trust a centralized aggregator's reputation or demand cryptographic proof such as TEE attestation; the discussion concluded reputation alone is weak for offenses like data harvesting because clear evidence rarely surfaces, making attestation the stronger answer.

**Q: Why pay for a managed enclave database instead of self-hosting?**

Self-hosted high-availability clusters carry heavy ongoing operational cost, which is why developers abandon them; running the cluster in confidential VMs at a small premium over commodity managed databases adds attestation-backed guarantees that no human, including the operator, has touched the data.


## references

- [BIP-360: Pay to Quantum Resistant Hash (post-quantum Bitcoin proposal)](https://github.com/bitcoin/bips/blob/master/bip-0360.mediawiki)
- [FIPS 203: ML-KEM (Kyber) post-quantum key encapsulation standard](https://csrc.nist.gov/pubs/fips/203/final)
- [EIP-5573: Sign-In with Ethereum capability delegations (ReCaps)](https://eips.ethereum.org/EIPS/eip-5573)
- [dstack: open-source TEE deployment framework](https://github.com/Dstack-TEE/dstack)

## provenance

Distilled from a private-vault transcript (`project-intros-local-private-first-phil-2026-05-20`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `speaker-pending`.

This session included external or featured speakers. The readout is held to thematic, unattributed distillation; a richer version requires a speaker consent pass.
