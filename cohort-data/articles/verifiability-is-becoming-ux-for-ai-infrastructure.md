---
record_id: verifiability-is-becoming-ux-for-ai-infrastructure
record_type: article
schema_version: 1
title: "Verifiability is becoming UX for AI infrastructure"
slug: verifiability-is-becoming-ux-for-ai-infrastructure
editorial_section: verifiability ux
audience: cohort
status: draft
content_version: "v0.0.3"
published_at: null
authored_week: w1.5
sources:
  - "TEE / dstack / easyTEE / Phala session notes"
  - "dstack session notes"
related_clusters: [dstack]
related_teams: [teesql, abra, tinycloud, conclave, elizaos]
related_people: []
working_angle: "Remote attestation and deployable proof are moving from backend trust primitives into things users can see, understand, and act on."
---

# Verifiability is becoming UX for AI infrastructure

*Why it matters: the projects on #dstack are no longer competing on whether they can attest something — they're competing on how few steps a skeptical user takes to verify it themselves.*

## TL;DR

The week's TEE / #dstack sessions made one move visible: **verifiability is shifting from a backend property into the user journey.** The product is no longer the proof — it's the path the user walks to produce the proof. Five things surfaced:

- **easyTEE** makes "rebuild the image yourself" a one-command path from a laptop (reproducible image + attestation hashes). The audit surface shrinks to something another engineer can inspect before lunch.
- **Platform-independent measurement reconstruction** decouples the trust story from any one cloud — no more per-cloud footnote.
- **RA-TLS may not need a rewrite** — swap the measurement inputs underneath the stable shape instead of replacing the protocol.
- **The bootstrap ritual is the real product surface** — declare host bring-up as a systemd service graph; the bootstrap script *is* the trust story, expressed as bash.
- **The smallest useful primitive may not be Kubernetes** — attested WireGuard + peer discovery + measurement-gated join beats Coco for most cohort projects.

> Provenance, open questions, and the full resources table are in the [Appendix](#appendix--double-click).

## the claim

For most of the last decade, verifiability in TEE infrastructure has been a backend property. A relying party checks an RTMR value once, the rest of the system trusts it forever, and end users never see the chain. The week's TEE work made the opposite move visible: **verifiability is starting to live inside the user journey, not under it.** The interesting projects in #dstack are no longer competing on whether they can attest something — they're competing on how few steps a paranoid user has to take to verify it themselves.

That shift changes what "good" looks like for everyone in this cluster. The product is no longer the proof. The product is the path the user walks to produce the proof.

## what surfaced this week

### 1. easyTEE made "rebuild it yourself" a one-command path from a laptop

A visiting Flashbots contributor walked the room through easyTEE / Make OSI: clone a small repo, run `make build`, and a Nix-based VM spits out a reproducible image plus attestation hashes. Sources lock to Debian snapshots, and caching makes repeat builds fast enough that rebuilding is no longer a ceremonial audit step. Yocto can technically do this. In practice nobody did, because the setup tax was crushing. The audit surface is what changes: the path from source code to attestation becomes small enough for another engineer to inspect.

This is the verifiability-as-UX move in its purest form. "Trust us, the image is reproducible" becomes "here is a script, here is the hash, run it yourself." That is no longer a security feature. That is the onboarding flow.

If you're shipping a TEE-backed product to anyone outside the cohort, the question to start asking is: *can the first skeptical engineer on the customer's team rebuild your image before lunch?* If yes, you have a story. If no, you have marketing.

### 2. Measurement reconstruction stopped being cloud-coupled

The deeper architectural move was platform-independent measurement reconstruction. Instead of trusting GCP-specific TPM flows or Azure-specific RTMR values, the verifier reconstructs the expected measurements from image data, event data, and hardened ACPI handling. Same image, same measurement, across bare metal and any cloud.

That matters because the old trust story still had a cloud-specific footnote. When ACPI tables or firmware change, teams end up deploying into a specific cloud just to pull measurements back and bless them. The ACPI hardening approach has a published security argument behind it; that paper should be checked before anyone in the cluster ships a public claim about measurement reconstruction.

For deployers in #abra, #tinycloud, #conclave: this is the difference between *"our trust story has a footnote per cloud"* and *"our trust story is one diagram."* The latter is something a customer's security review can actually consume. The former gets stuck in procurement.

### 3. RA-TLS may not need a rewrite — just new inputs

The original framing was "do we replace RA-TLS with attested TLS?" Flashbots is building an attested TLS layer, but waiting for it is not the only path. The pragmatic landing was simpler: if easyTEE can produce the RTMR values, dstack may be able to keep the RA-TLS shape and change the measurement inputs underneath it.

KMS, gateway, and CVM registration flows don't have to be migrated together. The first integration becomes a measurement-source swap, not a protocol change.

This matters because the riskiest part of any verifiability story is the migration. Every protocol replacement that's "obviously better" runs into six months of "but what about the old clients." Changing the inputs underneath a stable shape is the version of this that actually ships in week 6, not month 6.

### 4. The bootstrap ritual is the real product surface

#teesql moved the room from cryptography back to operations. The hard part of dstack is not proving what's running inside a CVM. It's bringing the host side up in order — SGX local key provider, KMS, VMM, gateway, PMS/TMS, PCCS/QGS, second-node onboarding, key sharing. Today this is a manual ritual. The direction the group converged on is to declare it as a systemd service graph and let easyTEE produce a *host* image as well as guest images, so the user journey becomes:

1. install
2. bootstrap the first node
3. invite or join
4. deploy CVMs

That sequence is also the verifiability sequence. Every step in it is something a customer can re-derive and check. The bootstrap script *is* the trust story, expressed as bash.

A complementary integration pattern surfaced in the same conversation: a **mono-repo** pinning versions of PS, KMS, CVM image, host image, and dstack Rust patches together. That solves a different problem from easyTEE itself — it gives the cluster a single coordinate where "this version of the stack works together" can be asserted and reproduced. For #teesql in particular, that may be the cheaper way to give downstream users a stable release surface before the full host-image story lands.

### 5. The smallest useful primitive may not be Kubernetes

Phala raised Coco / Kubernetes / confidential containers as the multi-CVM coordination layer. The room was skeptical — not because Coco is wrong, but because for most cohort projects the orchestration layer is bigger than the problem. The lighter primitive the group sketched: attested WireGuard, peer discovery, a small coordination layer, policy over which measurements/versions can join. A private network that already knows what's allowed to be on it.

If anyone in the cohort is rebuilding a service-mesh-shaped system inside their own project right now, this is the cross-team conversation to start before week 3. There is a real chance the cohort shares one primitive instead of three.

## a moment worth naming

Early in the dstack session, #elizaos mentioned forking Debian for an agent-runnable OS, using Tails as a reference fork. The visiting Flashbots contributor immediately recognized the same problem they had spent months on for TEE images: how do you make a small, auditable Debian-derived system that can run agent or blockchain workloads and still be compatible with TEEs? Within minutes, easyTEE / Make OSI stopped being a niche TEE image tool and became a possible answer to an agent-OS problem too.

Two cohort surfaces, same primitive, arrived at independently. That is the kind of cross-project moment the success rubric is designed to catch — and the kind that is invisible if nobody writes it down.

If you found yourself in a hallway conversation this week where someone else's tool obviously fits your problem, *say so in your weekly intention.* That is the signal `pair_with` exists to carry.

## what to do with this

Concrete moves, ranked by who they're for:

- **#teesql, #abra, #tinycloud, #conclave (dstack deployers).** Write down every manual step you currently take to bring up dstack from scratch. The shortest list wins. That document is the spec for the host image.
- **#elizaos and anyone forking Debian for an agent workload.** Look at easyTEE / Make OSI before you write more Yocto. If it's the wrong fit, the comparison is itself a useful artifact for the cluster.
- **Anyone who has UI feedback on dstack or Phala Cloud.** Phala explicitly asked for it in the room. Phala is rare among infra teams in actively inviting cluster-internal feedback before locking the UX — this window is open now and almost certainly narrows after the June 14 demo night. If you've been quietly cursing a bootstrap flow, the highest-leverage 30 minutes you can spend this week is writing it down and sending it to the Phala team.
- **Whoever wants the cross-team primitive.** Prototype the install / bootstrap / join flow as a user journey before writing more low-level code. If the journey is the verifiability story, the journey is the project.
- **Anyone with service-mesh experiments running.** Compare your design against attested WireGuard + peer discovery + measurement-gated join before you reach for Kubernetes.

## why this article exists

Verifiability used to be the part of the stack that vanished after audit. The week's sessions suggest it is becoming the part of the stack a user feels first. The cohort has unusual leverage here — five projects sit on the same primitive, one visiting contributor brought the unblock, and the rest of the cluster is one bootstrap script away from a shared story. The window to converge on that story is now.

## appendix — double-click

*Provenance and reference material: the cross-project connections, the open questions, and the full table of everything named in the room.*

### cross-project connections from these two sessions

- Flashbots ↔ Phala/dstack: Debian-snapshot reproducibility + caching answers Phala's repeat-build pain.
- Phala ↔ Flashbots: GCP TPM coupling problem ↔ platform-independent measurement reconstruction.
- #teesql ↔ Flashbots: RA-TLS input-swap unblocks dstack without waiting on Flashbots' attested-TLS ship date.
- #teesql ↔ Phala ↔ Flashbots: manual bootstrap ritual ↔ declarative systemd service graphs + easyTEE-built host image.
- #teesql ↔ Flashbots: host/guest image split ↔ mono-repo for version pinning.
- Phala ↔ Flashbots: Coco/Kubernetes skepticism → convergence on attested WireGuard + peer discovery as a lighter primitive.

### open questions for the cluster

- Which dstack Yocto customizations map cleanly into easyTEE config, and which need real porting work?
- Is the first integration best done by feeding new measurements into existing RA-TLS, or by introducing a clean v2 attested TLS path?
- What is the minimum host image needed to make first-node bootstrap reliable?
- How should redundancy and second-node onboarding be presented so users understand the key-sharing model without reading source?
- Which multi-CVM coordination primitive is enough before we have to reach for Coco?

### resources mentioned

Anything named in the room, with provenance. URLs are only listed when already known or stated clearly enough to verify before sharing externally.

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **easyTEE** | Reproducible Debian-based TEE image build system | Flashbots | confirm exact repository slug before sharing externally |
| **Make OSI / MK OSI** | Packer-like Debian spin-off builder with Nix VM + caching; powers easyTEE | Flashbots | — (search "mkosi" — likely the systemd `mkosi` tool, not stated in transcript) |
| **dstack** | Confidential-computing control plane (KMS, gateway, CVM registration, RA-TLS) | Phala, #teesql, Flashbots | Phala project; not linked in transcript |
| **Phala / Phala Cloud** | Confidential-compute platform; dstack is the control plane | Phala | — |
| **Flashbots** | Crypto/MEV infra org; building easyTEE + attested TLS | Flashbots | — |
| **Flashbox** | Flashbots TEE product line; consumes easyTEE | Flashbots | — |
| **VStack** | Flashbots product; first integration target for easyTEE | #teesql, #elizaos, Flashbots | — |
| **TeeSQL** | #teesql's project — TEE-backed Postgres | #teesql (implicit) | `teesql.com` (from team record, not transcript) |
| **elizaOS** | #elizaos agent operating system; forking Debian for agent workloads | #elizaos | — |
| **Tails** | Debian fork focused on privacy/security; elizaOS reference fork | #elizaos, Flashbots | — |
| **Yocto** | Embedded Linux build system; contrasted as heavy and hard to audit | Flashbots, Phala | — |
| **Coco (Confidential Containers)** | Kubernetes-based multi-CVM orchestration; discussed and partially rejected | Phala, Flashbots | — |
| **Contrast** | Hardened Coco variant | Phala, Flashbots | — |
| **Edge List paper** | Security paper justifying ACPI/AML sandboxing approach | Flashbots | — (cite explicitly when shipping public claims) |
| **RA-TLS** | Remote-attestation TLS; protocol used inside dstack | Flashbots, #teesql | — |
| **Attested TLS** | Successor to RA-TLS, in development at Flashbots | Flashbots | — |
| **WireGuard** | VPN protocol; basis for "attested WireGuard" multi-CVM primitive | Flashbots, Phala | — |
| **Nix** | Functional package manager; used in Make OSI build environment | Flashbots | — |
| **Debian snapshots** | Historical Debian archive (snapshot.debian.org) enabling reproducible builds | Flashbots, Phala | — |
| **systemd service graphs** | Declarative service-dependency model; proposed for bootstrap image definition | #teesql, Flashbots | — |
| **Packer** | HashiCorp image-build tool; used as Make OSI analogy | Flashbots | — |
| **Intel SGX local key provider** | Bootstrap component for dstack | Phala, #teesql | — |
| **Intel PCCS / QGS** | Platform Certification Caching Service / Quote Generation Service — TDX attestation infra | Phala, Flashbots | available through Debian packaging paths; confirm details before publishing |
| **GCP TPM flows** | Google Cloud's TPM measurement path; the platform coupling being decoupled | Flashbots, Phala | — |
| **Azure TDX** | Microsoft's confidential compute; ACPI variance challenge | Flashbots, Phala | — |

A few names appeared in the room but did not get pinned to a URL or a clear scope: **PMS / TMS**, **PSEC / PSAC** (dstack-internal acronyms; the Phala team can clarify), the proposed **Flashbots Debian repo** for pre-packaged reproducible binaries (not yet live), and the proposed **mono-repo** for version pinning PS / KMS / CVM / host image / dstack Rust patches.
