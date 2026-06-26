# Privacy is not the product; capability is the product

*Why it matters: private AI is interesting only in proportion to the capability it unlocks — so the projects that win are the ones that can name the workflow their privacy primitive makes possible, in one sentence.*

## TL;DR

"Private AI" is not a product category — it's a permission slip for a capability that couldn't exist before. The product is what the privacy makes possible; if privacy only buys you "the same thing, but attested," it's theatre. This week's dstack salon + local-first intros showed every load-bearing privacy primitive paired with a workflow that didn't work without it:

- **Private inference must feel identical to the non-private version** — verifiability as an on-demand side channel, not in the user's face.
- **Privacy unlocks proprietary-code-as-a-service** — license a model into a customer's environment, prove what it can't do, without revealing weights. A genuinely new business model.
- **Declarative beats heroic** — multi-node confidential compute is only real once bootstrap collapses to one declarative file.
- **Attestation: one click for the skeptic, zero clicks for everyone else.**
- **Local-first is a workflow demand, not a category** — put capability on the user's machine only when the workflow requires the user be the only party who can act.

> Cross-project connections, open questions, and the full resources tables are in the [Appendix](#appendix--double-click).

## the claim

For the last three years, "private AI" has been pitched as a product category in its own right. Private inference. Private training data. Private fine-tuning. The pitch decks all look the same: a list of capabilities, with "private" appended as a modifier. The cohort projects sitting on actual confidential-compute primitives — #teesql, #abra, #tinycloud, #conclave, #etherea, #signalstack, and the local-first cluster sketched in the Day 2 intros — have an opportunity to make a sharper claim: **private AI is not a product category. It is a permission slip for a capability that previously could not exist.** The product is what the privacy makes possible. If the answer to "what is this privacy unlocking?" is *"the same thing as the non-private version, but with attestation"*, then the privacy is theatre and the product is marketing.

This week's dstack salon made the cleaner version of this argument visible: every load-bearing privacy primitive on display was paired with a specific workflow that did not work without it. The interesting projects in the cluster are the ones that can name that workflow in one sentence.

## what surfaced this week

### 1. Private inference has to feel identical to the non-private version

Phala's dstack demo showed verifiable LLM inference at near-parity with the ChatGPT experience, with an attestation receipt attached to every response — each output signed so a user can verify it genuinely came from the model running inside the TEE.

The product design choice is important: verifiability is a *side channel*, not a primary UX. The user types into a ChatGPT-shaped interface. The skeptical user — or the customer's compliance officer — can crack open the receipt and walk the chain. Everyone else gets a chatbot. That is what capability-first privacy looks like: the privacy story is available on demand, not in the user's face.

For #signalstack, #etherea, and any cohort project that wants to ship "AI with provenance," the pattern is the same — the inference UX must be at parity with the non-private version. If the privacy story shows up as a worse chat experience, customers will route around it.

### 2. Privacy unlocks proprietary-code-as-a-service — a workflow that didn't exist before

A coordinator surfaced a use case the cohort should pay attention to: there are model owners willing to run their proprietary AI model inside a sandbox so they can license access to it in an un-premised environment. The privacy primitive (a CVM that can run proprietary code with declarable, attestable limits — e.g. proving a component has no internet access) enables a *new business model*, not just a more secure version of an old one.

This is the form of the claim worth repeating: **the capability is licensing-under-attestation.** A model owner can ship a binary into a customer's environment, prove what the binary can't do, and the customer can verify it without seeing the weights. That entire transaction did not exist as a credible workflow before confidential compute became deployable.

For #abra and #tinycloud, that's a concrete commercial path: not "we deploy your model securely" but *"we make your model rentable to customers who would otherwise refuse to run it on-prem."*

### 3. Operational friction is the deciding factor — declarative beats heroic every time

Phala's framing for the declarative cluster bootstrap is the operational version of the same argument: setting up a distributed VPN cluster manually — asking everybody to exchange keys by hand — is too hard to be a product; but if the cluster can be defined declaratively, the whole thing becomes pluggable by image.

Privacy infrastructure that requires a manual key-distribution ritual on every deploy is not a product. It is a research artifact. The capability it claims to provide — multi-node confidential compute — only exists as a real workflow once the bootstrap collapses to one declarative file. The cohort projects sitting on multi-node deployments (#dcnet, #conclave, anything with a distributed TEE story) should be measuring themselves against this bar: *can a customer who has never touched a TEE bring up a working cluster from a YAML file?* If no, the privacy is real but the capability is not.

### 4. The attestation must be one click for the skeptic, zero clicks for everyone else

Phala demonstrated the attestation verification flow as a small web tool that extracts and verifies quote fields — RTMR 0/1/2/3, MRTD, MR-Config. It is good that it exists. It is *better* that no end user has to use it to get value out of the underlying product.

The pattern is the same as proof #1: capability-first design hides the proof until someone asks for it. The skeptic clicks one thing and gets the whole chain. The end user gets a working app. For #conclave — turning private participant evidence into organizer signal — that exact UX is load-bearing. Participants need to trust the consent model without reading the source. Organizers need to verify the signal without seeing the raw evidence. The privacy is the gating mechanism; the *signal that gets produced* is the product.

### 5. Local-first is a workflow demand, not a category

The Day 2 intro session — shorthanded in the program as the "local / private-first" cluster — produced an honest realization worth surfacing. Most of the cohort projects nominally targeting local-first don't actually optimize for it as a primary axis. #tinycloud put it most directly: Tiny Cloud is currently local-second, not local-first — because customers haven't asked for local-first, they've asked for higher-level capabilities. The technical capability exists; the demand pulls toward higher-level workflows.

That reframes the category. Local-first is not a destination that cohort projects either ship or fail to ship. It is a position on a spectrum of user control that becomes a workflow requirement *when the workflow itself demands it*. Three moments in the session show this:

- During the Q&A on the **"Alien Love"** AI-game debrief, the presenter refused to let an audience member's harness run the game remotely — the local device was the boundary. The local boundary wasn't privacy in the abstract; it was the precondition for an honest game mechanic. The capability being unlocked (a shared emotional experience without platform capture) required an endpoint the player controls.
- **#pramaana / PALC** described an identity flow where the government ID is destroyed at enrollment, leaving only an on-chain commitment plus a small secret key on the user's device — the original data mathematically gone. The local key is load-bearing because the workflow — unlinkable pseudonyms across services with no central re-linkage — is only credible if no central party can rebuild the chain. Privacy is the mechanism; the capability is "one identity, infinite unlinkable pseudonyms."
- **#tinycloud** then made the spectrum explicit: a user's data can live on a self-hosted node, on a trusted third-party node, or on a Tiny Cloud node running inside a TEE. Hosted TEE is *one option on a spectrum*, not the default. The user picks the position on the spectrum that the workflow requires.

The pattern across all three: **the local end of the spectrum is a workflow constraint, not a marketing posture.** When the workflow requires the user to be the only party who can do something, the architecture has to put that capability on the user's machine. When it doesn't, insisting on it is product theatre — the inverse trap the verifiability companion piece names from the trust-layer angle.

#tinycloud articulated the underlying claim the cohort should adopt: data asymmetry is having information someone else doesn't have, and maintaining that asymmetry selectively while you gain capabilities with AI is the shape of what the cluster is building. That formulation works for #pramaana, #tinycloud, #bitrouter, #conclave, and the hosted-TEE half of the cluster simultaneously. The product is the asymmetry the workflow needs. The privacy primitive is what holds the asymmetry in place.

### 6. Verification by TEE is one path; verification by local control is another — same capability claim

#bitrouter framed the same pattern from yet another angle. Its agent-routing problem — most LLM gateways outside the US either get rate-limited, censored, or inject malicious responses — has two ways to recover trust: route through a centralized, credible provider (OpenRouter), or run in a TEE that provides a proof.

Read alongside the "this is my local device" stance from the Alien Love debrief, the spectrum becomes legible. The capability — *"I know what code touched my prompt"* — can be unlocked by running the code on your own machine, or by running it in a TEE someone else operates and verifying it remotely. Same capability claim, different architectures. The cluster is not choosing between "local-first" and "hosted-TEE" as competing categories. It's deciding *per workflow* which end of the spectrum gives the user the asymmetry the workflow needs.

## a moment worth naming

The dstack salon and the Day 2 local-first intro session, scheduled back-to-back, are not coincidence in programming. They are two faces of the same cohort thesis: that the next wave of differentiation in AI infrastructure is not "more capable models" but *"capabilities that were previously legally, operationally, or commercially impossible."* TEEs make one half of those capabilities possible (verifiable hosted compute). Local-first stacks make the other half possible (compute that the user already controls). Both are arguing — in cohort-internal vocabulary — that *privacy is the permission slip, and the capability is what gets shipped*.

If the projects in #dstack, #confidential-data, and the local-first cluster talk to each other this week, the shared claim almost writes itself. If they don't, the cohort risks shipping two parallel narratives that compete for the same external attention at the June 14 demo night.

## what to do with this

Concrete moves, ranked by who they're for:

- **#teesql, #abra, #tinycloud, #conclave, #signalstack, #etherea.** For your project, write one sentence: *"This capability did not exist as a credible workflow before our privacy primitive made it possible."* If you can't write that sentence, you are pitching privacy as a product. Fix the sentence first.
- **#conclave, #signalstack, #etherea — anyone building AI-with-provenance.** Audit your UX against the Phala test: can a non-technical user use the product without ever touching the attestation chain? Can a skeptical user verify the entire chain in under five minutes? Both must be true.
- **#abra, #tinycloud.** The proprietary-code-as-a-service angle is sitting on the table. If anyone wants to scope a commercial workflow with sandboxed-model-licensing as the product, this is the cohort week to do it — the primitive demo exists.
- **#dcnet, #conclave, anyone with a multi-node TEE story.** Push your bootstrap toward declarative-from-YAML. The capability you're selling does not exist until that ritual collapses to one file.
- **Local-first cluster.** A 60-minute joint session with the #dstack cluster this week would be high-leverage. The two halves of the argument are stronger together than apart.

## why this article exists

Half the cohort is sitting on privacy primitives that are interesting only in proportion to the capability they unlock. The June 14 demo night is roughly three weeks away, and the version of this argument that lands outside the cohort is *not* "we built private AI infra." It is "we made [specific workflow] possible for the first time, and here's the privacy primitive that made it credible." The cohort projects that can finish that sentence in one breath go to demo night with a story. The ones that can't go with a deck.

## appendix — double-click

*Provenance and reference material: the cross-project connections, the open questions, and the full tables of everything named in the room.*

### cross-project connections this week

- **#teesql ↔ Phala/dstack** — RA-TLS input-swap unblocks dstack integration without waiting on Flashbots' attested-TLS ship date. Capability unlock: #teesql gets a stable measurement story without a protocol migration.
- **#abra / #tinycloud / #conclave / #signalstack ↔ Phala (private inference)** — verifiable LLM inference with on-demand attestation receipts is the UX template for every "AI with provenance" workflow in the cluster. One implementation, four downstream products.
- **Proprietary-code sandbox ↔ #abra** — sandboxed proprietary execution with declarable network limits is the commercial path for #abra: "we make your model rentable inside customer environments."
- **Phala (declarative cluster bootstrap) ↔ #dcnet ↔ #conclave** — declarative multi-node TEE bootstrap is the unlock for both DCNet's overlay network and Conclave's distributed evidence-aggregation flows.
- **#tinycloud ↔ #pramaana** — #tinycloud's "user-owned data spaces enabling agentic workflows" and Pramaana's "each service gets a unique pseudonym" map onto each other directly: Pramaana can issue the pseudonym, Tiny Cloud can be the space the pseudonym authorizes against. One integration, two products with a sharper claim.
- **#bitrouter ↔ #signalstack, #etherea, #conclave** — #bitrouter's "TEE attestation as the trust recovery path for third-party model gateways" is exactly the proof shape the AI-with-provenance projects need to ship. One implementation pattern; multiple downstream users.
- **#pramaana ↔ #teesql** — both projects design from a post-quantum baseline (ML-KEM-1024 / PALC on the Pramaana side, TDX + reproducible builds on the dstack side). That shared assumption is a sharper joint claim for demo night than either makes alone.
- **Local-first presenter ↔ #tinycloud** — the "this is my local device" stance and #tinycloud's three-data-location architecture share an intuition: consent-respecting interaction requires a boundary the user controls. The two halves of one category claim.
- **#tinycloud standing offer** — its "customers haven't asked for local-first" is a standing invitation to any cohort project whose workflow *does* demand it. If your product needs user-controlled storage, the integration target exists in the cohort.

### open questions for the cluster

- For each cohort project sitting on a privacy primitive: what capability does it enable that was not credibly available before? (One sentence, not a paragraph.)
- Where does the local-first claim end and the hosted-TEE claim begin? Are they competing, or are they two regions of one workflow?
- How does the proprietary-code-as-a-service workflow get packaged as a product the cohort can co-distribute, rather than a one-off integration per customer?
- What does "the attestation is one click for the skeptic, zero clicks for everyone else" look like as a design rubric — and which cohort projects could publish that rubric jointly?

### resources mentioned

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **dstack** | Confidential-compute control plane (KMS, gateway, CVM registration, RA-TLS, service mesh) | Phala, #teesql, a coordinator | Phala project |
| **Phala Cloud** | Hosted dstack with free dev credits | Phala | phala.cloud (stated in salon) |
| **dstack web-host** | Multi-app multiplexer within a single CVM; dev/attested mode split | a coordinator | — |
| **dstack private-inference demo** | Chat-API at parity with ChatGPT UX with attestation receipts | Phala | demoed in salon; URL not stated |
| **dstack service-mesh** | Multi-CVM coordination via Consul + remote attestation; Postgres HA example shown | Phala | integrated with HashiCorp Consul |
| **Phala SDK** | Python library for in-CVM attestation/key-derivation requests | Phala | `pip install phala-sdk` (inferred) |
| **dstack examples repo** | Reference workloads: SSH server, light client, co-processor, Tor, K3s | Phala | dstack-te/dstack-examples (tentative slug — verify) |
| **dstack CLI** | Command-line automation; pairs with Cloud Code | Phala | `phala deploy`, etc. |
| **dstack Ingress** | Custom-domain routing with TLS termination inside the TEE | Phala | built into dstack |
| **RA-TLS** | Remote-attestation TLS protocol used by dstack | Phala, a coordinator | — |
| **Attestation verification web tool** | UI for extracting and verifying RTMR/MRTD/MR-Config quote fields | Phala | URL not stated in salon |
| **Intel TDX** | CPU-level TEE platform | Phala | Intel spec |
| **Intel SGX local key provider / PCCS / QGS** | dstack bootstrap dependencies | Phala, a coordinator | available via Debian repo per salon |
| **Consul (HashiCorp)** | Service-mesh control plane integrated with dstack | Phala | — |
| **Patroni** | Leader-election manager for HA Postgres in the salon demo | Phala | — |
| **Terraform** | IaC tool used to deploy the service-mesh CVMs | Phala | — |
| **K3s** | Lightweight Kubernetes — one of the dstack example workloads | Phala | — |
| **Deno / gVisor (runsc)** | Sandboxing options for app isolation inside dstack web-host | a coordinator | — |
| **App ID** | Per-application identifier used in the dstack HTTPS endpoint | Phala | — |

#### Local-first session resources

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **Alien Love** | An AI-game demoed in the session — LLM + game-loop progression intended to test whether LLMs can produce shared emotional experience | a visiting contributor | code held locally; not distributed |
| **Pramaana / PALC** | Post-quantum anonymous-credential identity stack — destroys PII at enrollment, leaves on-chain commitment + local secret key | #pramaana | open-source per session; repo via cohort team `#pramaana` |
| **ML-KEM-1024** | NIST-standardized post-quantum key-encapsulation; used in Pramaana's key-generation pipeline | #pramaana | NIST FIPS 203 |
| **Anonymous self-credentials paper** | Cited as the cryptographic basis for the PII-derived seed approach | #pramaana | confirm author/title before citing publicly |
| **Tiny Cloud** | User-owned data spaces + permission delegation; supports self-host / third-party-host / Tiny Cloud TEE-host as three deployment options | #tinycloud | repo via cohort team `#tinycloud` |
| **OpenKey** | Custodial signer (passkeys) inside Tiny Cloud; based on prior Spruce work | #tinycloud | — |
| **ReCaps / SIWE Capabilities** | Delegated capabilities in signed messages — EIP standard for capability delegation | #tinycloud | EIP referenced; verify number |
| **Spruce ID** | Identity stack that informed Tiny Cloud's self-sovereign approach | #tinycloud | spruceid.com |
| **PlanetScale** | MySQL hosting used as one Tiny Cloud production-data backend | #tinycloud | planetscale.com |
| **Ceramic** | Decentralized data network; source of the set-reconciliation replication algorithm Tiny Cloud borrows | #tinycloud | ceramic.network |
| **BitRouter** | Open-source LLM/API router with TEE-attested option; 2-5% markup vs OpenRouter's 5-30% | #bitrouter | repo via cohort team `#bitrouter` |
| **OpenRouter** | Centralized model-aggregator; comparative reference | #bitrouter (comparative) | openrouter.io |
| **SiliconFlow** | China-based serverless inference provider; cited as an example of the third-API-gateway pattern | #bitrouter | — |
| **Bittensor** | Decentralized inference marketplace; cited as another point on the routing spectrum | #bitrouter | bittensor.com |
| **Worldcoin** | Iris-biometric identity stack; comparative reference (centralized biometric storage; Pramaana differs by keeping biometric-derived seed local-only) | #pramaana (comparative) | worldcoin.org |
| **Fractal ID** | Web3 KYC stack with 14-day document retention; comparative reference | #pramaana (comparative) | fractal.id |

---

*Sources: dstack salon session notes (2026-05-20) and Day 2 local / private-first intro session notes (2026-05-20) — the Alien Love debrief plus #tinycloud, #pramaana / PALC, and #bitrouter intros. See also the companion piece `verifiability-is-becoming-ux-for-ai-infrastructure.md` for the parallel argument from the trust-layer side, and `why-llm-agents-need-memory-workflows-and-social-routing.md` for the agent-infrastructure half of the same week.*
