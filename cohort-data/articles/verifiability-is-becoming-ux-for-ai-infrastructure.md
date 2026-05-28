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
  - "dstack session notes with Alex, Shaw, LSDan, and Andrew"
related_clusters: [dstack]
related_teams: [teesql, abra, tinycloud, conclave, elizaos]
related_people: [lsdan, shaw-walters]
working_angle: "Remote attestation and deployable proof are moving from backend trust primitives into things users can see, understand, and act on."
---

# Verifiability is becoming UX for AI infrastructure

## the claim

For most of the last decade, verifiability in TEE infrastructure has been a backend property. A relying party checks an RTMR value once, the rest of the system trusts it forever, and end users never see the chain. The week's TEE work made the opposite move visible: **verifiability is starting to live inside the user journey, not under it.** The interesting projects in #dstack are no longer competing on whether they can attest something — they're competing on how few steps a paranoid user has to take to verify it themselves.

That shift changes what "good" looks like for everyone in this cluster. The product is no longer the proof. The product is the path the user walks to produce the proof.

## what surfaced this week

### 1. easyTEE made "rebuild it yourself" a one-command path from a laptop

Alex walked the room through easyTEE / Make OSI: clone a small repo, run `make build`, and a Nix-based VM spits out a reproducible image plus attestation hashes. Sources lock to Debian snapshots, and caching makes repeat builds fast enough that rebuilding is no longer a ceremonial audit step. Yocto can technically do this. In practice nobody did, because the setup tax was crushing. The audit surface is what changes: the path from source code to attestation becomes small enough for another engineer to inspect.

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

LSDan moved the room from cryptography back to operations. The hard part of dstack is not proving what's running inside a CVM. It's bringing the host side up in order — SGX local key provider, KMS, VMM, gateway, PMS/TMS, PCCS/QGS, second-node onboarding, key sharing. Today this is a manual ritual. The direction the group converged on is to declare it as a systemd service graph and let easyTEE produce a *host* image as well as guest images, so the user journey becomes:

1. install
2. bootstrap the first node
3. invite or join
4. deploy CVMs

That sequence is also the verifiability sequence. Every step in it is something a customer can re-derive and check. The bootstrap script *is* the trust story, expressed as bash.

A complementary integration pattern surfaced in the same conversation: a **mono-repo** pinning versions of PS, KMS, CVM image, host image, and dstack Rust patches together. That solves a different problem from easyTEE itself — it gives the cluster a single coordinate where "this version of the stack works together" can be asserted and reproduced. For #teesql in particular, that may be the cheaper way to give downstream users a stable release surface before the full host-image story lands.

### 5. The smallest useful primitive may not be Kubernetes

Hang raised Coco / Kubernetes / confidential containers as the multi-CVM coordination layer. The room was skeptical — not because Coco is wrong, but because for most cohort projects the orchestration layer is bigger than the problem. The lighter primitive the group sketched: attested WireGuard, peer discovery, a small coordination layer, policy over which measurements/versions can join. A private network that already knows what's allowed to be on it.

If anyone in the cohort is rebuilding a service-mesh-shaped system inside their own project right now, this is the cross-team conversation to start before week 3. There is a real chance the cohort shares one primitive instead of three.

## a moment worth naming

Early in the dstack session, Shaw (#elizaos) mentioned that he has been forking Debian for an agent-runnable OS, using Tails as a reference fork. Alex immediately recognized the same problem he had spent months on for TEE images: how do you make a small, auditable Debian-derived system that can run agent or blockchain workloads and still be compatible with TEEs? Within minutes, easyTEE / Make OSI stopped being a niche TEE image tool and became a possible answer to an agent-OS problem too.

Two cohort surfaces, same primitive, arrived at independently. That is the kind of cross-project moment the success rubric is designed to catch — and the kind that is invisible if nobody writes it down.

If you found yourself in a hallway conversation this week where someone else's tool obviously fits your problem, *say so in your weekly intention.* That is the signal `pair_with` exists to carry.

### other cross-project connections from these two sessions

- Alex (Flashbots) ↔ Hang (Phala/dstack): Debian-snapshot reproducibility + caching answers Phala's repeat-build pain.
- Hang ↔ Alex: GCP TPM coupling problem ↔ platform-independent measurement reconstruction.
- LSDan (#teesql) ↔ Alex: RA-TLS input-swap unblocks dstack without waiting on Flashbots' attested-TLS ship date.
- LSDan ↔ Hang ↔ Alex: manual bootstrap ritual ↔ declarative systemd service graphs + easyTEE-built host image.
- LSDan ↔ Alex: host/guest image split ↔ mono-repo for version pinning.
- Hang ↔ Alex: Coco/Kubernetes skepticism → convergence on attested WireGuard + peer discovery as a lighter primitive.

## what to do with this

Concrete moves, ranked by who they're for:

- **#teesql, #abra, #tinycloud, #conclave (dstack deployers).** Write down every manual step you currently take to bring up dstack from scratch. The shortest list wins. That document is the spec for the host image.
- **#elizaos and anyone forking Debian for an agent workload.** Look at easyTEE / Make OSI before you write more Yocto. If it's the wrong fit, the comparison is itself a useful artifact for the cluster.
- **Anyone who has UI feedback on dstack or Phala Cloud.** Hang explicitly asked for it in the room. Phala is rare among infra teams in actively inviting cluster-internal feedback before locking the UX — this window is open now and almost certainly closes after the midterm. If you've been quietly cursing a bootstrap flow, the highest-leverage 30 minutes you can spend this week is writing it down and sending it to Hang.
- **Whoever wants the cross-team primitive.** Prototype the install / bootstrap / join flow as a user journey before writing more low-level code. If the journey is the verifiability story, the journey is the project.
- **Anyone with service-mesh experiments running.** Compare your design against attested WireGuard + peer discovery + measurement-gated join before you reach for Kubernetes.

## open questions for the cluster

- Which dstack Yocto customizations map cleanly into easyTEE config, and which need real porting work?
- Is the first integration best done by feeding new measurements into existing RA-TLS, or by introducing a clean v2 attested TLS path?
- What is the minimum host image needed to make first-node bootstrap reliable?
- How should redundancy and second-node onboarding be presented so users understand the key-sharing model without reading source?
- Which multi-CVM coordination primitive is enough before we have to reach for Coco?

## resources mentioned

Anything named in the room, with provenance. URLs are only listed when already known or stated clearly enough to verify before sharing externally.

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **easyTEE** | Reproducible Debian-based TEE image build system | Alex (Flashbots) | confirm exact repository slug before sharing externally |
| **Make OSI / MK OSI** | Packer-like Debian spin-off builder with Nix VM + caching; powers easyTEE | Alex | — (search "mkosi" — likely the systemd `mkosi` tool, not stated in transcript) |
| **dstack** | Confidential-computing control plane (KMS, gateway, CVM registration, RA-TLS) | Hang, LSDan, Alex | Phala project; not linked in transcript |
| **Phala / Phala Cloud** | Confidential-compute platform; dstack is the control plane | Hang | — |
| **Flashbots** | Crypto/MEV infra org; building easyTEE + attested TLS | Alex | — |
| **Flashbox** | Flashbots TEE product line; consumes easyTEE | Alex | — |
| **VStack** | Flashbots product; first integration target for easyTEE | LSDan, Shaw, Alex | — |
| **TeeSQL** | LSDan's project — TEE-backed Postgres | LSDan (implicit) | `teesql.com` (from person record, not transcript) |
| **elizaOS** | Shaw's agent operating system; forking Debian for agent workloads | Shaw | — |
| **Tails** | Debian fork focused on privacy/security; elizaOS reference fork | Shaw, Alex | — |
| **Yocto** | Embedded Linux build system; contrasted as heavy and hard to audit | Alex, Hang | — |
| **Coco (Confidential Containers)** | Kubernetes-based multi-CVM orchestration; discussed and partially rejected | Hang, Alex | — |
| **Contrast** | Hardened Coco variant | Hang, Alex | — |
| **Edge List paper** | Security paper justifying ACPI/AML sandboxing approach | Alex | — (cite explicitly when shipping public claims) |
| **RA-TLS** | Remote-attestation TLS; protocol used inside dstack | Alex, LSDan | — |
| **Attested TLS** | Successor to RA-TLS, in development at Flashbots | Alex | — |
| **WireGuard** | VPN protocol; basis for "attested WireGuard" multi-CVM primitive | Alex, Hang | — |
| **Nix** | Functional package manager; used in Make OSI build environment | Alex | — |
| **Debian snapshots** | Historical Debian archive (snapshot.debian.org) enabling reproducible builds | Alex, Hang | — |
| **systemd service graphs** | Declarative service-dependency model; proposed for bootstrap image definition | LSDan, Alex | — |
| **Packer** | HashiCorp image-build tool; used as Make OSI analogy | Alex | — |
| **Intel SGX local key provider** | Bootstrap component for dstack | Hang, LSDan | — |
| **Intel PCCS / QGS** | Platform Certification Caching Service / Quote Generation Service — TDX attestation infra | Hang, Alex | available through Debian packaging paths; confirm details before publishing |
| **GCP TPM flows** | Google Cloud's TPM measurement path; the platform coupling being decoupled | Alex, Hang | — |
| **Azure TDX** | Microsoft's confidential compute; ACPI variance challenge | Alex, Hang | — |

A few names appeared in the room but did not get pinned to a URL or a clear scope: **PMS / TMS**, **PSEC / PSAC** (dstack-internal acronyms; Phala team can clarify), the proposed **Flashbots Debian repo** for pre-packaged reproducible binaries (not yet live), and the proposed **mono-repo** for version pinning PS / KMS / CVM / host image / dstack Rust patches.

## why this article exists

Verifiability used to be the part of the stack that vanished after audit. The week's sessions suggest it is becoming the part of the stack a user feels first. The cohort has unusual leverage here — five projects sit on the same primitive, one visiting contributor brought the unblock, and the rest of the cluster is one bootstrap script away from a shared story. The window to converge on that story is now.
