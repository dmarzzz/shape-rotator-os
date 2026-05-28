---
record_id: verifiability-is-becoming-ux-for-ai-infrastructure
record_type: article
schema_version: 1
title: "Verifiability is becoming UX for AI infrastructure"
slug: verifiability-is-becoming-ux-for-ai-infrastructure
editorial_section: verifiability ux
audience: cohort
status: draft
content_version: "v0.0.2"
published_at: null
authored_week: w1.5
sources:
  - "TEE dstack easyTEE Phala Transcript (2026-05-27)"
  - "dstack hangout Alex Shaw LSDan Andrew (2026-05-27)"
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

Alex (Flashbots) walked the room through easyTEE / Make OSI: clone a small repo, run `make build`, and a Nix-based VM spits out a reproducible image plus attestation hashes — *"all in one command from a MacBook"* (~7:37). Sources lock to Debian snapshots; aggressive caching reduces repeat builds *"to seconds instead of a very long time"* (Hang, ~6:54). Yocto can technically do this. In practice nobody did, because the setup tax was crushing, and as Alex put it, the audit surface is what changes: *"unlike Yocto, where you're pulling in all of these different things… this is the audit chamber. This is very small, so people can actually open up your software and understand how you get from source code to attestation"* (~9:05).

This is the verifiability-as-UX move in its purest form. "Trust us, the image is reproducible" becomes "here is a script, here is the hash, run it yourself." That is no longer a security feature. That is the onboarding flow.

If you're shipping a TEE-backed product to anyone outside the cohort, the question to start asking is: *can the first skeptical engineer on the customer's team rebuild your image before lunch?* If yes, you have a story. If no, you have marketing.

### 2. Measurement reconstruction stopped being cloud-coupled

The deeper architectural move was platform-independent measurement reconstruction. As Alex framed it: *"this gives you a set of measurement hashes that are independent of platform — the same hash can be used to verify a running Azure instance or bare metal instance or GCP instance"* (~17:35). Instead of trusting GCP-specific TPM flows or Azure-specific RTMR values, the verifier reconstructs the expected measurements from image data, event data, and hardened ACPI handling. Same image, same measurement, across bare metal and any cloud.

Hang named the problem this solves precisely: *"you may have dstack and GCP, but the attestation pipeline still assumes trust in Google, and it's flaky in the sense that when the ACPI table changes, or when the firmware changes, you have to physically deploy to GCP, get the measurements, pull them back, and somebody has to trust those measures"* (~14:31). The ACPI hardening approach has a published justification — Alex pointed at *"the edge list as a research paper explaining this particular… security paper, which explains why this is secure"* (~21:43). Worth reading before anyone in the cluster ships a public claim about measurement reconstruction.

For deployers in #abra, #tinycloud, #conclave: this is the difference between *"our trust story has a footnote per cloud"* and *"our trust story is one diagram."* The latter is something a customer's security review can actually consume. The former gets stuck in procurement.

### 3. RA-TLS may not need a rewrite — just new inputs

The original framing was "do we replace RA-TLS with attested TLS?" Flashbots is in fact building an attested TLS layer (Alex, ~33:21: *"we're running at Flashbots right now, attested TLS"*), but waiting for it is not the only path. The pragmatic landing came from LSDan: *"if you can use this to just produce those RTMR values, then you don't even have to modify RA-TLS at all. You just modify the inputs into RA-TLS, which allows you to keep this whole system exactly, and then you don't even need to wait for Flashbots to update our RA-TLS alternatives"* (~21:23). Alex agreed.

KMS, gateway, and CVM registration flows don't have to be migrated together. The first integration becomes a measurement-source swap, not a protocol change.

This matters because the riskiest part of any verifiability story is the migration. Every protocol replacement that's "obviously better" runs into six months of "but what about the old clients." Changing the inputs underneath a stable shape is the version of this that actually ships in week 6, not month 6.

### 4. The bootstrap ritual is the real product surface

LSDan moved the room from cryptography back to operations. The hard part of dstack is not proving what's running inside a CVM. It's bringing the host side up in order — SGX local key provider, KMS, VMM, gateway, PMS/TMS, PCCS/QGS, second-node onboarding, key sharing. Today this is a manual ritual. The direction the group converged on is to declare it as a systemd service graph and let easyTEE produce a *host* image as well as guest images, so the user journey becomes:

1. install
2. bootstrap the first node
3. invite or join
4. deploy CVMs

That sequence is also the verifiability sequence. Every step in it is something a customer can re-derive and check. The bootstrap script *is* the trust story, expressed as bash.

A complementary integration pattern surfaced in the same conversation: Alex proposed a **mono-repo** pinning versions of PS, KMS, CVM image, host image, and dstack Rust patches together (~1:05:21). That solves a different problem from easyTEE itself — it gives the cluster a single coordinate where "this version of the stack works together" can be asserted and reproduced. For #teesql in particular, that may be the cheaper way to give downstream users a stable release surface before the full host-image story lands.

### 5. The smallest useful primitive may not be Kubernetes

Hang raised Coco / Kubernetes / confidential containers as the multi-CVM coordination layer. The room was skeptical — not because Coco is wrong, but because for most cohort projects the orchestration layer is bigger than the problem. The lighter primitive the group sketched: attested WireGuard, peer discovery, a small coordination layer, policy over which measurements/versions can join. A private network that already knows what's allowed to be on it.

If anyone in the cohort is rebuilding a service-mesh-shaped system inside their own project right now, this is the cross-team conversation to start before week 3. There is a real chance the cohort shares one primitive instead of three.

## a moment worth naming

Early in the dstack hangout, Shaw (#elizaos) mentioned in passing that he's been forking Debian for an agent-runnable OS — using Tails as a reference fork, having been *"in this for a minute"* (~1:52, ~7:55). Alex (Flashbots) immediately recognized the same problem he had spent months on for TEE images: *"trust me, I have been down that rabbit hole for the past year. There is a thing called Make OSI"* (~2:27). Within minutes Shaw landed on it himself: *"This is awesome. So you're like, yeah, I want to make my own Debian fork. This is your business."* Alex closed the loop: *"you want not only do you want to make your own Debian fork, do you want to make one that's really small, designed to run in particular agent workloads or blockchain workloads, and you want it to be compatible with TEEs. Yeah, this is your solution."* (~3:32–3:50).

Two cohort surfaces, same primitive, arrived at independently. That is the kind of cross-project moment the success rubric is designed to catch — and the kind that is invisible if nobody writes it down.

If you found yourself in a hallway conversation this week where someone else's tool obviously fits your problem, *say so in your weekly intention.* That is the signal `pair_with` exists to carry.

### other cross-project connections from these two sessions

- **[5:40 / 6:54]** Alex (Flashbots) ↔ Hang (Phala/dstack): Debian-snapshot reproducibility + caching answers Phala's repeat-build pain.
- **[14:31 / 17:35]** Hang ↔ Alex: GCP TPM coupling problem ↔ platform-independent measurement reconstruction.
- **[21:23]** LSDan (#teesql) ↔ Alex: RA-TLS input-swap unblocks dstack without waiting on Flashbots' attested-TLS ship date.
- **[42:49 / 1:00:01]** LSDan ↔ Hang ↔ Alex: manual bootstrap ritual ↔ declarative systemd service graphs + easyTEE-built host image.
- **[1:02:15 / 1:05:21]** LSDan ↔ Alex: host/guest image split ↔ mono-repo for version pinning.
- **[1:12:53]** Hang ↔ Alex: Coco/Kubernetes skepticism → convergence on attested WireGuard + peer discovery as a lighter primitive.

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

## voices from the room

Verbatim where possible. Transcripts are otter.ai auto-generated, so some lines carry mishears — preserved with `[sic]` where the meaning still reads.

### Alex (Flashbots / easyTEE)

- **[0:09 hangout]** on why easyTEE is a layer, not a product: *"My goal is not to release this as a product akin to VStack, but to have it be a foundational layer that things like VStack and Flashbox can all build upon, so that we can cross-pollinate ideas… right now everybody is reinventing the wheel on their own, and doing so in such a way that requires a lot of maintenance."*
- **[1:31 hangout]** on reproducible binaries as a distribution channel: *"Flashbox will make a Debian repo that has all of the [ref etc.] in it, pre-packaged as reproducible binaries that can be independently verified, and once you reference that repo, it has all the metadata required for you to verify the [build hashes][sic]."*
- **[5:40]** on audit-grade Debian pulls: *"It pulls the packages directly from the Debian repository, but it gives you ways to rebuild those reproducibly… if you're super paranoid, you can do that too."*
- **[9:05]** on shrinking the audit surface: *"Unlike Yocto, where you're pulling in all of these different things and you have to fork them and change them — this is the audit chamber. This is very small, so people can actually open up your software and understand how you get from source code to attestation."*
- **[17:35]** on platform-independent measurement: *"This gives you a set of measurement hashes that are independent of platform — the same hash can be used to verify a running Azure instance or bare metal instance or GCP instance."*
- **[21:43]** on the ACPI security argument: *"If you check the edge list as a research paper explaining this particular… it is a security paper, which explains why this is secure."*
- **[33:21]** on attested TLS at Flashbots: *"We're running at Flashbots right now, attested TLS."*

### Hang (Phala / dstack)

- **[6:54]** on caching as a workflow unlock: *"Does it have a cache to build? So next time I run that it just takes a few minutes instead of a very long time… anyone can just use that itself, and they get all the [producer files][sic], and they can hash the file to get the measurements."*
- **[14:31]** on the GCP coupling problem: *"You may have dstack and GCP, but the attestation pipeline still assumes trust in Google, and it's flaky in the sense that when the ACPI table changes, or when the firmware changes, you have to physically deploy to GCP, get the measurements, pull them back, and then somebody has to trust those measures."*
- **[42:49]** on the dstack bootstrap sequence: *"To bootstrap the dstack system, first we need to run the SGX local key provider… and then once this is running — it's a stateless service — we run KMS, but KMS is also running [an attestation flow][sic], a PSEC, essentially a PSAC."*
- **[1:02:39]** on declarative cluster bootstrap: *"If you want to set this up as a distributed VPN cluster, right now it would be too hard because you'd have to ask everybody to set that up manually with keys — but if you can define it declaratively using this, then all of this becomes [pluggable by image][sic]."*
- **[1:12:53]** on Coco skepticism: *"The most promising way is still to use Coco confidential container. But the problem with confidential container is that it doesn't have any web-three people, so almost everything's missing here."*

### LSDan (#teesql)

- **[4:51 hangout]** framing the dstack integration goal: *"The purpose of today is to try to get [dstack] to start using all of this stuff, so that we can move further and further into this being productionized and easy to use. The main sticking point so far has been with Hawkins[sic], especially the idea of the self-building images — he still thinks customers are really going to want the guest image that's already built for them."*
- **[21:23]** on the RA-TLS input swap: *"If you can use this to just produce those RTMR values, then you don't even have to modify RA-TLS at all. You just modify the inputs into RA-TLS, which allows you to keep this whole system exactly — and then you don't even need to wait for Flashbots to update our RA-TLS alternatives."*
- **[1:02:15]** on collapsing the bootstrap ritual: *"You have one of these, which is your bootstrap image. So you get a bare metal machine, and the first thing you do is turn on your bootstrap image, and that contains all of this stuff. From that point forward, all you're doing is deploying regular CVMs on the guest… what it eliminates is the manual part, because right now there are various reboots and different things."*

### Shaw (#elizaos)

- **[1:52 hangout]** on forking Debian for agents: *"I'm working on an agent operating system… we're actually forking Debian, like everyone's doing that now, because we can't actually build agents on current hardware without a lot of limitations."*
- **[2:49 hangout]** on Tails as a reference: *"We're actually using Tails, which is another Debian fork, as kind of our example."*
- **[3:32 hangout]** the realization: *"This is awesome. So you're like, yeah, I want to make my own Debian fork. This is your business."*

## resources mentioned

Anything named in the room, with provenance. URLs are only listed when stated verbatim in the transcripts.

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **easyTEE** | Reproducible Debian-based TEE image build system | Alex (Flashbots) | stated as `github.com/easy-te` in hangout (~3:52); confirm exact slug before sharing externally |
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
| **Intel PCCS / QGS** | Platform Certification Caching Service / Quote Generation Service — TDX attestation infra | Hang, Alex | available via Debian repo per Alex (~1:01) |
| **GCP TPM flows** | Google Cloud's TPM measurement path; the platform coupling being decoupled | Alex, Hang | — |
| **Azure TDX** | Microsoft's confidential compute; ACPI variance challenge | Alex, Hang | — |

A few names appeared in the room but did not get pinned to a URL or a clear scope: **PMS / TMS**, **PSEC / PSAC** (dstack-internal acronyms; Phala team can clarify), the proposed **Flashbots Debian repo** for pre-packaged reproducible binaries (not yet live), and the proposed **mono-repo** for version pinning PS / KMS / CVM / host image / dstack Rust patches.

## why this article exists

Verifiability used to be the part of the stack that vanished after audit. The week's sessions suggest it is becoming the part of the stack a user feels first. The cohort has unusual leverage here — five projects sit on the same primitive, one visiting contributor brought the unblock, and the rest of the cluster is one bootstrap script away from a shared story. The window to converge on that story is now.

---

*Sources: TEE / dstack / easyTEE / Phala session (2026-05-27) and the dstack hangout with Alex (Flashbots), Shaw, LSDan, Andrew (2026-05-27). See `member-highlights/2026-05-27-tee-dstack-easytee-phala.md` for the source-backed beat-by-beat.*
