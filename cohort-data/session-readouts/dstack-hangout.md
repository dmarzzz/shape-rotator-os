---
vault_id: dstack-hangout
date: null
title: "dstack hangout: reproducible Debian base images for TEE and agent workloads"
kind: hangout
consent: cohort-internal
teams: [elizaos]
people: [shaw-walters, lsdan, albiona-hoti]
source: private-vault:dstack-hangout
---

# dstack hangout: reproducible Debian base images for TEE and agent workloads

**Reproducible base images, so "self-verifiable" stops meaning "nobody verifies."**

*Informal dstack-adjacent session on building a shared, reproducible Debian image layer that TEE stacks and agent operating systems can both build on instead of reinventing image tooling.*

## the 60-second version

An informal hangout on building a shared, reproducible Debian image layer that both TEE stacks and agent operating systems can build on — distributed as a verifiable package repo and built with mkosi instead of a hand-maintained fork. The point: Yocto-style images are technically reproducible but so painful to rebuild that almost nobody does, which quietly breaks the whole trust story.

## themes

- Reproducible and verifiable TEE base images
- Shared foundational infrastructure over per-project wheel reinvention
- Convenience vs verifiability in image distribution

## insights

- A program-side engineer is building a foundational image-building layer beneath dstack-style TEE stacks, designed as an SDK: usable out of the box or forked and extended, with security patches and new features structured as modules that downstream forks can pull in without heavy maintenance.
- The distribution plan centers on a Debian package repository of reproducible binaries that can be independently verified, with the repo carrying the metadata needed to check builds and attestation, so consumers reference the repo rather than rebuilding everything themselves.
- mkosi was strongly recommended over hand-rolling a Debian fork for minimal ISOs; it works like Packer for custom Debian spin-offs, and the discussed setup pairs it with a Nix environment and an in-VM build so a skeptical verifier can clone the repo, run one build command, and reproduce the image file.
- This directly addresses the known weakness of Yocto-style self-building images: they are technically reproducible but so painful to set up that almost nobody actually self-builds, which undermines the trust story.
- There is a converging pattern of teams building minimal, security-hardened Debian derivatives (with Tails as a structural reference, including its kernel and hardening recommendations) tailored to agent and blockchain workloads with TEE compatibility, rather than running stock distros.
- On the prebuilt-vs-self-built tension, the position discussed was to serve both audiences: ship ready-made guest images for customers who want an out-of-the-box solution, while keeping the self-build path trivial for anyone who wants transparency around reproducibility and attestation.

## q&a

**Q: Is there an easier way to produce a minimal custom Debian ISO than maintaining a full fork (e.g. of Tails)?**

Yes — use mkosi instead of forking. It behaves like Packer for Debian spin-offs, yields a small base ISO with hardening patches included, and avoids the months-long pain of maintaining a fork by hand.


## references

- [mkosi (systemd project for building OS images)](https://github.com/systemd/mkosi)
- [Tails (Debian-based hardened live OS)](https://tails.net)
- [dstack (open-source TEE deployment stack)](https://github.com/Dstack-TEE/dstack)

## provenance

Distilled from a private-vault transcript (`dstack-hangout`); the raw transcript is held privately per the content policy and never published. Paraphrased throughout — no verbatim speaker quotes. consent tier: `cohort-internal`.
