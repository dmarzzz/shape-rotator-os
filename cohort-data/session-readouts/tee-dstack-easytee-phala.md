---
vault_id: tee-dstack-easytee-phala
date: null
title: "TEE Convergence Salon: dstack, easyTEE, and Platform-Independent Attestation"
kind: salon
consent: cohort-internal
teams: [teesql]
people: [lsdan, wiktoria-leks, gonzo-gelso, andrew-miller]
source: private-vault:tee-dstack-easytee-phala
---

# TEE Convergence Salon: dstack, easyTEE, and Platform-Independent Attestation

A whiteboard session mapping Flashbots-derived reproducible-build and event-level attestation tooling onto Phala's dstack, converging on attested TLS, attested WireGuard, and one-command bootstrap.

## themes

- Reproducible TEE image builds
- Platform-independent attestation and measurement
- Attested transport layers (aTLS, attested WireGuard)
- Deployment bootstrap and orchestration convergence

## insights

- A declarative, mkosi-style build system (easyTEE, derived from Flashbots production image tooling) compresses large Yocto meta-layer stacks into roughly a hundred lines of configuration, pins packages to dated Debian archive snapshots so anyone rebuilding years later gets bit-identical artifacts, and runs the whole build inside a throwaway VM clone — one command on an ordinary laptop yields both the image and its attestation hashes, addressing the reality that almost no end users ever successfully rebuild Yocto-based TEE images to verify measurements themselves.
- The open build tooling stays maintained as a byproduct of production needs: security and hardening patches flow from the production image repos through a strictly scoped shared directory into the public project, so cohort and ecosystem teams inherit upstream security updates without separate maintenance goodwill.
- Event-level attestation replaces opaque register comparison: instead of matching raw RTMR0/1/2 values, the verifier carries individual boot-event measurements (kernel, initrd, ACPI hashes, RAM size, disk count) alongside each TDX quote and reconstructs the expected quote at verification time — producing reference values that stay stable across firmware changes and work identically on bare metal, GCP, and Azure, removing the need to trust cloud vTPM attestation chains that ultimately reduce to trusting the cloud provider.
- Because ACPI/AML cannot be trusted by default, the discussed hardening whitelists only the few opcodes and table types hypervisor VMs actually use and patches the kernel to refuse unsafe tables — so the mere existence of a valid TDX quote implies safe ACPI, eliminating per-platform measurement churn; the approach parallels published research on malicious AML and similar work done for SEV-SNP, where ACPI tables are unmeasured.
- Only a handful of inputs actually perturb RTMR0: RAM size shifts handoff-table placement and disk count changes the boot options UEFI enumerates, while CPU count does not affect the measurement — meaning reference values can be regenerated deterministically from a short declared input list rather than re-measured per deployment.
- dstack can adopt platform-independent attestation without a wire-protocol change: feed reconstructed RTMR reference values from the event-level verifier into the existing RA-TLS validation inputs (or negotiate a v2 of the handshake), so the KMS, gateway, and CVM registration paths gain portability while existing deployments keep working.
- The dstack cold-start sequence (hardware key provider, VMM, bootstrap KMS, gateway, then second-node onboarding for redundancy) was identified as the most error-prone manual step, with ordering and race issues; the converged design bakes these components into specialized declaratively built images orchestrated by systemd dependency graphs, collapsing setup to an install script plus a bootstrap-or-join step with invite URLs for redundant key-management nodes.
- On orchestration, running Kubernetes inside a CVM is trivial but adds no value, and Confidential Containers was judged over-engineered for this ecosystem; the convergent alternative is attested WireGuard plus a small Consul-style distributed key-value layer with attestation-gated key release — and the group noted that many teams across the program and the wider ecosystem keep reinventing exactly this service-mesh-shaped plumbing, making small importable modules for attestation, attested transport, and peer discovery the highest-leverage shared investment.

## q&a

**Q: How does the build system guarantee reproducibility without depending on a third-party build framework?**

It pins every package to a dated snapshot of the Debian archive (which retains depublished packages for over a decade), builds inside a disposable clone of an already-reproducible filesystem, and applies a default set of reproducibility compiler flags that covers large real-world codebases — so identical inputs produce identical artifacts even when rebuilt years later, and dependency changes simply invalidate the cache.

**Q: Can the platform-independent attestation approach handle GPU confidential VMs?**

GPUs attach as PCI devices and mostly contribute hardware-topology entries to ACPI; with topology-only AML permitted, GPU machines yield slightly different ACPI hashes but flow through the same verification path, and current datacenter GPU generations have been exercised by teams in the room.

**Q: Should a team fork the shared image builder or consume it as an upstream dependency?**

Fork it for full ownership — the per-project layer typically reduces to a few lines of declarative configuration, while security updates continue to flow from upstream, and forking preserves flexibility for custom kernel modules and platform-specific image variants.

**Q: Why not build multi-CVM orchestration on Confidential Containers?**

It was assessed as over-engineered for what this ecosystem needs; most teams really want inter-CVM networking with attested identity and shared state, which attested WireGuard plus a distributed key-value store with policy-gated key release can deliver with far less fighting against an external framework.

**Q: How do redundant key-management nodes share a stable key when the TEE hardware offers no persistent key API?**

A hardware-backed local key provider outside the CVM returns a stable key to the bootstrap KMS, which seals it to disk; additional nodes then join through an onboarding protocol rather than re-bootstrapping, since each fresh bootstrap would otherwise mint a new key — this onboarding step is the part the group most wants to automate away.


## references

- [dstack repository (Dstack-TEE)](https://github.com/Dstack-TEE/dstack)
- [Phala Network documentation](https://docs.phala.network)
- [mkosi declarative image builder (systemd)](https://github.com/systemd/mkosi)
- [Confidential Containers project](https://github.com/confidential-containers)
- [Contrast (Edgeless Systems), prior art on hardening CoCo](https://github.com/edgelesssys/contrast)
- [Debian snapshot archive](https://snapshot.debian.org)
