---
vault_id: dstack-intro-salon-2026-05-20
date: 2026-05-20
title: "Dstack Intro Salon: TEE Deployment 101, Multiplexed CVMs, and Attested Service Meshes"
kind: workshop
consent: cohort-internal
teams: [shape-rotator-os]
people: [lsdan, andrew-miller]
source: private-vault:dstack-intro-salon-2026-05-20
---

# Dstack Intro Salon: TEE Deployment 101, Multiplexed CVMs, and Attested Service Meshes

A hands-on walkthrough of deploying confidential VMs with dstack, plus deep dives on multiplexing many attested apps in one CVM and building an attestation-gated service mesh across TEEs.

## themes

- Lowering the barrier to TEE deployment with dstack
- Remote attestation and reproducible verification chains
- Multiplexing sub-apps in a single CVM with dev-to-attested promotion
- Scaling TEEs out: attested service meshes and high-availability clusters

## insights

- dstack abstracts TEE deployment down to the Docker Compose level: you supply containers plus a compose file, and the framework handles CVM provisioning, boot-sequence measurement, and remote attestation; the whole stack is open source, with a hosted cloud option for quick starts.
- Key management is decoupled from hardware: apps derive deterministic keys from a KMS (either cloud-managed or anchored to a smart contract on a chain like Base or Ethereum), so a CVM can migrate between machines and still derive the same keys — removing single-hardware lock-in and enabling encrypted stateful workloads.
- Each deployed app gets an app ID embedded in its HTTPS endpoint with TLS terminating inside the TEE, giving an end-to-end encrypted channel bound to the attested workload; deployment secrets are encrypted in the browser and only decrypted inside the CVM.
- Generating an attestation quote is easy (an SDK call returns TDX quotes exposing RTMR0-3, MRTD, and config measurements); the hard part is verification — linking those hashes back to source code requires reproducibly built OS images and tooling to compute reference values, which the dstack verification tutorial walks end to end.
- Whole CVMs are a scarce unit: TDX caps concurrent CVMs per machine in the low hundreds even on large processors, and each reserves memory and billing. This motivates a web-host multiplexing layer where many lightweight sub-apps share one CVM, each individually promotable from SSH-accessible dev mode to an attested mode that provably removes developer access.
- Sub-app attestation in a multiplexed CVM works by mediating the guest attestation socket: instead of letting sub-apps write raw user-report data, the host binds each sub-app's own hash into the report, partitioning attestation domains so co-tenant apps cannot masquerade as one another; SSH and ingress are similarly partitioned per sub-app.
- The threat model for multiplexed TEEs treats co-tenant dev-mode apps as the adversary: even a source-audited attested app could leak secrets through covert channels (e.g., key-dependent disk writes) readable by neighbors, and whether combining two isolation mechanisms (language-runtime sandboxes vs gVisor-style runsc containers) yields best-of or worst-of security is an open analysis question.
- A prototype TEE service mesh connects multiple CVMs via Consul with Envoy sidecar mTLS, where onboarding requires remote attestation checked against a coordinator policy (a whitelist of compose hashes) before connection keys are released; Terraform orchestrates the fleet, demonstrated as a three-node high-availability Postgres cluster using Patroni leader election.

## q&a

**Q: Why allow attested and unattested apps to coexist in the same CVM?**

To share one CVM across development and production-like workloads, and to keep the behavioral gap between modes minimal — promotion only disconnects developer SSH/debug access, nothing else changes. Since auditors typically review one promoted app at a time, the co-tenant dev-mode apps must always be modeled as threats anyway. A similar pattern exists elsewhere in industry: developers debug in-situ with test data only, and must lock out their own access before the system handles private data.

**Q: How do sub-apps inside one CVM request attestations without impersonating each other?**

The host never passes the raw attestation socket through. Each sub-app gets a partitioned attestation domain where its own code hash is bound into the user-report data, so it can influence but not forge the report — effectively mini-CVMs inside the CVM, with resources, SSH, and ingress also partitioned per app.

**Q: What is the minimal change to let parties under different accounts join the service mesh via a smart-contract-gated policy?**

Small: the admission policy is currently hardcoded in the mesh coordinator, and attestation checks already gate key release. Replacing the hardcoded policy with a lightweight client that reads the policy from a blockchain would make the mesh joinable across owners.

**Q: Should mesh admission whitelist compose hashes or app IDs?**

App-ID whitelisting inherits dstack's upgradeability and KMS-continuity guarantees (and can be managed on-chain), but forces an awkward deployment ordering. Compose-hash whitelisting lets all measurements be pre-calculated before deployment for a one-shot rollout, which is why it was chosen for the prototype.

**Q: How can code provenance be established for a proxy in front of multiple TEE inference providers?**

One pragmatic workaround: run a minimal launcher script inside the TEE that pulls a public Git repo, pins and checks the commit hash, and then executes it — so fetching and running the code both happen inside the attested environment, linking the attestation to a specific commit.


## references

- [dstack — open-source TEE deployment framework](https://github.com/Dstack-TEE/dstack)
- [dstack-examples — SSH-in-TEE, blockchain light client, Tor, k3s, custom-domain ingress patterns](https://github.com/Dstack-TEE/dstack-examples)
- [Phala Cloud — hosted dstack with CLI](https://cloud.phala.network)
- [RedPill — TEE-verified inference API with attestation reports and signed receipts](https://red-pill.ai)
- [HashiCorp Consul — service mesh control plane](https://www.consul.io)
- [Patroni — Postgres high-availability and leader election](https://github.com/patroni/patroni)
- [gVisor — runsc container sandbox](https://gvisor.dev)
- [Terraform — CVM fleet orchestration](https://www.terraform.io)
- [Deno — sandboxed runtime used for sub-app isolation](https://deno.com)
