# Privacy is not the product; capability is the product

## the claim

For the last three years, "private AI" has been pitched as a product category in its own right. Private inference. Private training data. Private fine-tuning. The pitch decks all look the same: a list of capabilities, with "private" appended as a modifier. The cohort projects sitting on actual confidential-compute primitives — #teesql, #abra, #tinycloud, #conclave, #etherea, #signalstack, the local-first cluster Phil sketched — have an opportunity to make a sharper claim: **private AI is not a product category. It is a permission slip for a capability that previously could not exist.** The product is what the privacy makes possible. If the answer to "what is this privacy unlocking?" is *"the same thing as the non-private version, but with attestation"*, then the privacy is theatre and the product is marketing.

This week's dstack salon made the cleaner version of this argument visible: every load-bearing privacy primitive on display was paired with a specific workflow that did not work without it. The interesting projects in the cluster are the ones that can name that workflow in one sentence.

## what surfaced this week

### 1. Private inference has to feel identical to the non-private version

Hang's dstack demo showed verifiable LLM inference where, in his words, *"on the left side you can see it gives you almost the identical experience compared with ChatGPT,"* with attestation receipts attached to every response: *"all the requests also has a receipt, so we sign the receipt with signatures — this guarantees you can verify this is indeed the outputs from TEE and running with some model."*

The product design choice is important: verifiability is a *side channel*, not a primary UX. The user types into a ChatGPT-shaped interface. The skeptical user — or the customer's compliance officer — can crack open the receipt and walk the chain. Everyone else gets a chatbot. That is what capability-first privacy looks like: the privacy story is available on demand, not in the user's face.

For #signalstack, #etherea, and any cohort project that wants to ship "AI with provenance," the pattern is the same — the inference UX must be at parity with the non-private version. If the privacy story shows up as a worse chat experience, customers will route around it.

### 2. Privacy unlocks proprietary-code-as-a-service — a workflow that didn't exist before

Andrew Miller surfaced a use case the cohort should pay attention to: *"there are actually a lot of people willing to put their proprietary AI model running in the sandbox, so they can license the access to their model in some un-premised environment."* The privacy primitive (a CVM that can run proprietary code with declarable, attestable limits — *"this component doesn't have access to the internet"*) enables a *new business model*, not just a more secure version of an old one.

This is the form of the claim worth repeating: **the capability is licensing-under-attestation.** A model owner can ship a binary into a customer's environment, prove what the binary can't do, and the customer can verify it without seeing the weights. That entire transaction did not exist as a credible workflow before confidential compute became deployable.

For #abra and #tinycloud, that's a concrete commercial path: not "we deploy your model securely" but *"we make your model rentable to customers who would otherwise refuse to run it on-prem."*

### 3. Operational friction is the deciding factor — declarative beats heroic every time

Hang's framing for the declarative cluster bootstrap is the operational version of the same argument: *"if you want to set this up as a distributed VPN cluster, right now it would be too hard, because you'd have to ask everybody to set that up manually with keys — but if you can define it declaratively using [this], then all of this becomes pluggable by image."*

Privacy infrastructure that requires a manual key-distribution ritual on every deploy is not a product. It is a research artifact. The capability it claims to provide — multi-node confidential compute — only exists as a real workflow once the bootstrap collapses to one declarative file. The cohort projects sitting on multi-node deployments (#dcnet, #conclave, anything with a distributed TEE story) should be measuring themselves against this bar: *can a customer who has never touched a TEE bring up a working cluster from a YAML file?* If no, the privacy is real but the capability is not.

### 4. The attestation must be one click for the skeptic, zero clicks for everyone else

Hang demonstrated the attestation verification flow as a small web tool that extracts and verifies quote fields — RTMR 0/1/2/3, MRTD, MR-Config. It is good that it exists. It is *better* that no end user has to use it to get value out of the underlying product.

The pattern is the same as proof #1: capability-first design hides the proof until someone asks for it. The skeptic clicks one thing and gets the whole chain. The end user gets a working app. For #conclave — turning private participant evidence into organizer signal — that exact UX is load-bearing. Participants need to trust the consent model without reading the source. Organizers need to verify the signal without seeing the raw evidence. The privacy is the gating mechanism; the *signal that gets produced* is the product.

### 5. Local-first is a workflow demand, not a category

The Day 2 intro session — shorthanded in the program as the "local / private-first" cluster — produced an honest realization worth surfacing. Most of the cohort projects nominally targeting local-first don't actually optimize for it as a primary axis. Sam Gbafa said it most directly about #tinycloud: *"Tiny Cloud right now is like it[sic] local second, not local first… but our customers haven't asked for that, they've kind of asked for like higher level stuff."* The technical capability exists; the demand pulls toward higher-level workflows.

That reframes the category. Local-first is not a destination that cohort projects either ship or fail to ship. It is a position on a spectrum of user control that becomes a workflow requirement *when the workflow itself demands it*. Three moments in the session show this:

- **Phil Daian**, during the Q&A on his "Alien Love" AI-game debrief, refused to let an audience member's harness run his game remotely: *"you're not going to own my endpoint here, are you?… this is my local device, you know."* The local boundary wasn't privacy in the abstract — it was the precondition for an honest game mechanic. The capability he was unlocking (a shared emotional experience without platform capture) required an endpoint the player controls.
- **Pramaana (#pramaana / PALC)** described an identity flow where the government ID is destroyed at enrollment and only a commitment-on-chain plus a small secret key on the user's device remain: *"What remains is the commitment on chain and a small secret key on your device. The original data is mathematically gone."* The local key is load-bearing because the workflow — unlinkable pseudonyms across services with no central re-linkage — is only credible if no central party can rebuild the chain. Privacy is the mechanism; the capability is "one identity, infinite unlinkable pseudonyms."
- **Sam Gbafa (#tinycloud)** then made the spectrum explicit: a user's data in his architecture can live on a self-hosted node, on a trusted third-party node, or on a Tiny Cloud node running inside a TEE. Hosted TEE is *one option on a spectrum*, not the default. The user picks the position on the spectrum that the workflow requires.

The pattern across all three: **the local end of the spectrum is a workflow constraint, not a marketing posture.** When the workflow requires the user to be the only party who can do something, the architecture has to put that capability on the user's machine. When it doesn't, insisting on it is product theatre — the inverse trap article #3 names from the verifiability angle.

Sam articulated the underlying claim in a sentence the cohort should adopt: *"data asymmetry is when you know something or you have some information that someone else doesn't have… maintaining data asymmetry selectively while you gain capabilities with AI is the shape of kind of what we're all doing here."* That formulation works for #pramaana, #tinycloud, #bitrouter, #conclave, and the hosted-TEE half of the cluster simultaneously. The product is the asymmetry the workflow needs. The privacy primitive is what holds the asymmetry in place.

### 6. Verification by TEE is one path; verification by local control is another — same capability claim

Kelsen Liu (#bitrouter) framed the same pattern from yet another angle. His agent-routing problem — most LLM gateways outside the US either get rate-limited, censored, or inject malicious responses — has *"two ways"* to recover trust: *"first, use Open[Router], because it's centralized and it's credible… the second way is, is actually why we want to be in this accelerator, because… through TEE, you provide a proof."*

Read alongside Phil's *"this is my local device,"* the spectrum becomes legible. The capability — *"I know what code touched my prompt"* — can be unlocked by running the code on your own machine, or by running it in a TEE someone else operates and verifying it remotely. Same capability claim, different architectures. The cluster is not choosing between "local-first" and "hosted-TEE" as competing categories. It's deciding *per workflow* which end of the spectrum gives the user the asymmetry the workflow needs.

## a moment worth naming

The dstack salon and the Phil intro session, scheduled back-to-back on Day 2, are not coincidence in programming. They are two faces of the same cohort thesis: that the next wave of differentiation in AI infrastructure is not "more capable models" but *"capabilities that were previously legally, operationally, or commercially impossible."* TEEs make one half of those capabilities possible (verifiable hosted compute). Local-first stacks make the other half possible (compute that the user already controls). Both are arguing — in cohort-internal vocabulary — that *privacy is the permission slip, and the capability is what gets shipped*.

If the projects in #dstack, #confidential-data, and the local-first cluster talk to each other this week, the shared claim almost writes itself. If they don't, the cohort risks shipping two parallel narratives that compete for the same external attention at the June 14 demo night.

### cross-project connections this week

- **#teesql (LSDan) ↔ Hang (Phala/dstack)** — RA-TLS input-swap unblocks dstack integration without waiting on Flashbots' attested-TLS ship date. Capability unlock: #teesql gets a stable measurement story without a protocol migration.
- **#abra / #tinycloud / #conclave / #signalstack ↔ Hang (private inference)** — verifiable LLM inference with on-demand attestation receipts is the UX template for every "AI with provenance" workflow in the cluster. One implementation, four downstream products.
- **Andrew Miller (proprietary code sandbox) ↔ #abra** — sandboxed proprietary execution with declarable network limits is the commercial path for #abra: "we make your model rentable inside customer environments."
- **Hang (declarative cluster bootstrap) ↔ #dcnet ↔ #conclave** — declarative multi-node TEE bootstrap is the unlock for both DCNet's overlay network and Conclave's distributed evidence-aggregation flows.
- **#tinycloud (Sam Gbafa) ↔ #pramaana** — Sam's "user-owned data spaces enabling agentic workflows" and Pramaana's "each service gets a unique pseudonym" map onto each other directly: Pramaana can issue the pseudonym, Tiny Cloud can be the space the pseudonym authorizes against. One integration, two products with a sharper claim.
- **#bitrouter (Kelsen) ↔ #signalstack, #etherea, #conclave** — Kelsen's "TEE attestation as the trust recovery path for third-party model gateways" is exactly the proof shape the AI-with-provenance projects need to ship. One implementation pattern; multiple downstream users.
- **#pramaana ↔ #teesql (LSDan)** — Both projects design from a post-quantum baseline (ML-KEM-1024 / PALC on the Pramaana side, TDX + reproducible builds on the dstack side). That shared assumption is a sharper joint claim for demo night than either makes alone.
- **Phil Daian ↔ #tinycloud (Sam)** — Phil's "this is my local device" and Sam's three-data-location architecture share an intuition: consent-respecting interaction requires a boundary the user controls. The two halves of one category claim.
- **#tinycloud standing offer** — Sam's "customers haven't asked for local-first" is a standing invitation to any cohort project whose workflow *does* demand it. If your product needs user-controlled storage, the integration target exists in the cohort.

## what to do with this

Concrete moves, ranked by who they're for:

- **#teesql, #abra, #tinycloud, #conclave, #signalstack, #etherea.** For your project, write one sentence: *"This capability did not exist as a credible workflow before our privacy primitive made it possible."* If you can't write that sentence, you are pitching privacy as a product. Fix the sentence first.
- **#conclave, #signalstack, #etherea — anyone building AI-with-provenance.** Audit your UX against the Hang test: can a non-technical user use the product without ever touching the attestation chain? Can a skeptical user verify the entire chain in under five minutes? Both must be true.
- **#abra, #tinycloud.** The proprietary-code-as-a-service angle is sitting on the table. If anyone wants to scope a commercial workflow with sandboxed-model-licensing as the product, this is the cohort week to do it — the primitive demo exists.
- **#dcnet, #conclave, anyone with a multi-node TEE story.** Push your bootstrap toward declarative-from-YAML. The capability you're selling does not exist until that ritual collapses to one file.
- **Local-first cluster (Phil's project intros).** A 60-minute joint session with the #dstack cluster this week would be high-leverage. The two halves of the argument are stronger together than apart.

## open questions for the cluster

- For each cohort project sitting on a privacy primitive: what capability does it enable that was not credibly available before? (One sentence, not a paragraph.)
- Where does the local-first claim end and the hosted-TEE claim begin? Are they competing, or are they two regions of one workflow?
- How does the proprietary-code-as-a-service workflow get packaged as a product the cohort can co-distribute, rather than a one-off integration per customer?
- What does "the attestation is one click for the skeptic, zero clicks for everyone else" look like as a design rubric — and which cohort projects could publish that rubric jointly?

## voices from the room

### Hang (Phala / dstack)

- on workflow abstraction as the product: *"dstack just takes all the burden to deploy on the TEE, and you just need to focus on [your application]."*
- on capability-equivalent UX: *"on the left side you can see it gives you almost the identical experience compared with ChatGPT… you can verify the remote attestation."*
- on verifiability as a side channel: *"all the requests also has a receipt — we sign the receipt with signatures, this guarantees you can verify this is indeed the outputs from TEE and running with some model."*
- on the proprietary-model use case: *"there are actually a lot of people willing to do so — they want to put their proprietary AI model running in the sandbox, so they can license the access to their model in some [un-premised][sic] environment."*
- on declarative bootstrap: *"if you want to set this up as a distributed VPN cluster, right now it would be too hard… but if you can define it declaratively using this, then all of this becomes pluggable by image."*

### Andrew Miller (coordinator / dstack-adjacent)

- on the sandbox-with-limits use case: *"having a convenient way that you can run proprietary stuff in kind of like a container where you can express limits of [flight to][sic] the proprietary code — that's really necessary for [the] last but very interesting application."*
- on the dev/attested mode split: *"the sweet spot for me is something where I have the option of dev mode, but I also have the ability to turn on like true no-backdoor — I can prove the whole attestation chain."*
- on multi-app multiplexing inside a single CVM: *"within a single CVM application you can have many different applications, which can either be in dev mode, where you can see full visibility into them, or you can promote them to a tested mode, where then you can prove to users using them that you no longer have any ability to influence their running or see the secrets that are running within them."*

### Phil Daian (visiting, IC3 / Flashbots — Alien Love debrief)

- on the local-endpoint boundary: *"you're not going to own my endpoint here, are you?… this is my local device, you know."*
- on the workflow privacy unlocks: *"we don't want to just dump our raw emotions to Sam Altman, that seems pretty horrible, and so it also motivates privacy-preserving TE[E]s."*
- on the design intent of the game: *"I wanted to see if LLMs could make us feel something… can we, together with LLMs, learn more about each other?"*

### Sam Gbafa (#tinycloud)

- on the data-asymmetry thesis: *"data asymmetry is when you know something or you have some information that someone else doesn't have… maintaining data asymmetry selectively while you gain capabilities with AI is the shape of kind of what we're all doing here."*
- on local-second honesty: *"Tiny Cloud right now is like it[sic] local second, not local first… but our customers haven't asked for that, they've kind of asked for like higher level stuff."*
- on the spectrum of data location: *"you can host your own data… you could trust someone else to host your data… we could host Tiny Cloud Node… we run [TinyCloud] nodes in trusted execution environments."*
- on the capability ad-hoc workflows unlock: *"user-owned structured permission data enables dynamic ad-hoc agentic applications… a food tracker… a pain tracker… a third app, which is this insights app — we've been collecting data for some time, let's do some correlations."*
- on identity as cybernetic substrate: *"if you live in Russia, and you get sanctioned… all of a sudden you've had a digital stroke… you no longer have access to part of your brain."*

### Pramaana (#pramaana / PALC)

- on the capability the credential destruction unlocks: *"you have access to every single place that requires verification of your private information… each service gets a unique pseudonym… you don't have to constantly connect your wallet, constantly prove that you're human."*
- on PII destruction at enrollment: *"we use the government ID itself as a cryptographic [seed]… there is no tracing back… we erase everything, the PII, the hash, the seed, the randomness, all wiped from the memory. What remains is the commitment on chain and a small secret key on your device. The original data is mathematically gone."*
- on privacy as background, not UX: *"a user doesn't want to know this is post-quantum, a user doesn't want to know this is all the encryption schemes that are involved. They just want ease of usage, they want high security."*

### Kelsen Liu (#bitrouter)

- on the recovery problem: *"the whole AI space — I become more and more like geopolitical… people here in the US, you guys can use GPT… but it is banned and blocked in a lot of countries… a lot of those [gateways] are injecting malicious calls and stealing credentials."*
- on the two trust paths: *"you have two ways. First, use Open[Router] because it's centralized and it's credible… the second way is, is actually why we want to be in this accelerator, because… through TEE, you provide a proof."*
- on the architectural goal: *"we want to make it a peer-to-peer router network. So if one of the server instances is down, the other one is still usable."*

## resources mentioned

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **dstack** | Confidential-compute control plane (KMS, gateway, CVM registration, RA-TLS, service mesh) | Hang, LSDan, Andrew Miller | Phala project |
| **Phala Cloud** | Hosted dstack with free dev credits | Hang | phala.cloud (stated in salon) |
| **dstack web-host** | Multi-app multiplexer within a single CVM; dev/attested mode split | Andrew Miller | — |
| **dstack private-inference demo** | Chat-API at parity with ChatGPT UX with attestation receipts | Hang | demoed in salon; URL not stated |
| **dstack service-mesh** | Multi-CVM coordination via Consul + remote attestation; Postgres HA example shown | Hang | integrated with HashiCorp Consul |
| **Phala SDK** | Python library for in-CVM attestation/key-derivation requests | Hang | `pip install phala-sdk` (inferred) |
| **dstack examples repo** | Reference workloads: SSH server, light client, co-processor, Tor, K3s | Hang | dstack-te/dstack-examples (tentative slug — verify) |
| **dstack CLI** | Command-line automation; pairs with Cloud Code | Hang | `phala deploy`, etc. |
| **dstack Ingress** | Custom-domain routing with TLS termination inside the TEE | Hang | built into dstack |
| **RA-TLS** | Remote-attestation TLS protocol used by dstack | Hang, Andrew Miller | — |
| **Attestation verification web tool** | UI for extracting and verifying RTMR/MRTD/MR-Config quote fields | Hang | URL not stated in salon |
| **Intel TDX** | CPU-level TEE platform | Hang | Intel spec |
| **Intel SGX local key provider / PCCS / QGS** | dstack bootstrap dependencies | Hang, Andrew Miller | available via Debian repo per salon |
| **Consul (HashiCorp)** | Service-mesh control plane integrated with dstack | Hang | — |
| **Patroni** | Leader-election manager for HA Postgres in the salon demo | Hang | — |
| **Terraform** | IaC tool used to deploy the service-mesh CVMs | Hang | — |
| **K3s** | Lightweight Kubernetes — one of the dstack example workloads | Hang | — |
| **Deno / gVisor (runsc)** | Sandboxing options for app isolation inside dstack web-host | Andrew Miller | — |
| **App ID** | Per-application identifier used in the dstack HTTPS endpoint | Hang | — |

### Phil-session resources

| Name | What it is | Mentioned by | URL / pointer |
|---|---|---|---|
| **Alien Love** | Phil's AI-game demoed in the session — LLM + game-loop progression intended to test whether LLMs can produce shared emotional experience | Phil Daian | code held locally; not distributed |
| **Pramaana / PALC** | Post-quantum anonymous-credential identity stack — destroys PII at enrollment, leaves on-chain commitment + local secret key | Pramaana team | repo via cohort team `#pramaana` |
| **ML-KEM-1024** | NIST-standardized post-quantum key-encapsulation; used in Pramaana's key-generation pipeline | Pramaana / PALC | NIST FIPS 203 |
| **Anonymous self-credentials paper** | Cited as the cryptographic basis for the PII-derived seed approach | Pramaana | confirm author/title before citing publicly |
| **Tiny Cloud** | User-owned data spaces + permission delegation; supports self-host / third-party-host / Tiny Cloud TEE-host as three deployment options | Sam Gbafa | repo via cohort team `#tinycloud` |
| **OpenKey** | Custodial signer (passkeys) inside Tiny Cloud; based on prior Spruce work | Sam Gbafa | — |
| **ReCaps / SIWE Capabilities** | Delegated capabilities in signed messages — EIP standard for capability delegation | Sam Gbafa | EIP referenced; verify number |
| **Spruce ID** | Identity stack that informed Tiny Cloud's self-sovereign approach | Sam Gbafa | spruceid.com |
| **PlanetScale** | MySQL hosting used as one Tiny Cloud production-data backend | Sam Gbafa | planetscale.com |
| **Ceramic** | Decentralized data network; source of the set-reconciliation replication algorithm Tiny Cloud borrows | Sam Gbafa | ceramic.network |
| **BitRouter** | Open-source LLM/API router with TEE-attested option; 2-5% markup vs OpenRouter's 5-30% | Kelsen Liu | repo via cohort team `#bitrouter` |
| **OpenRouter** | Centralized model-aggregator; comparative reference | Kelsen Liu (comparative) | openrouter.io |
| **SiliconFlow** | China-based serverless inference provider; cited as an example of the third-API-gateway pattern | Kelsen Liu | — |
| **Bittensor** | Decentralized inference marketplace; cited as another point on the routing spectrum | Kelsen Liu | bittensor.com |
| **Worldcoin** | Iris-biometric identity stack; comparative reference (centralized biometric storage; Pramaana differs by keeping biometric-derived seed local-only) | Pramaana comparative reference | worldcoin.org |
| **Fractal ID** | Web3 KYC stack with 14-day document retention; comparative reference | Pramaana comparative reference | fractal.id |

## why this article exists

Half the cohort is sitting on privacy primitives that are interesting only in proportion to the capability they unlock. The June 14 demo night is roughly three weeks away, and the version of this argument that lands outside the cohort is *not* "we built private AI infra." It is "we made [specific workflow] possible for the first time, and here's the privacy primitive that made it credible." The cohort projects that can finish that sentence in one breath go to demo night with a story. The ones that can't go with a deck.

---

*Sources: dstack salon session notes (2026-05-20) and Day 2 local / private-first intro session notes (2026-05-20) — Phil Daian's Alien Love debrief plus #tinycloud, #pramaana / PALC, and #bitrouter intros. See also article #3 (`verifiability-is-becoming-ux-for-ai-infrastructure.md`) for the parallel argument from the trust-layer side, and article #1 (`why-llm-agents-need-memory-workflows-and-social-routing.md`) for the agent-infrastructure half of the same week.*
