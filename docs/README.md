# Shape Rotator OS Docs

Last reviewed: 2026-06-14

This folder is the durable human-readable operating layer for Shape Rotator OS. It should explain policy, process, architecture, audits, and generated public-safe indexes. Raw transcript text and private operator exports do not belong here.

## Start Here

| Doc | Use it for | Status |
| --- | --- | --- |
| [Information rules](INFORMATION_RULES.html) | Visual guide for storage, naming, routing, privacy, and promotion rules. | Current operating policy |
| [Information rules markdown](INFORMATION_RULES.md) | Markdown source for the same operating policy. | Current operating policy |

## Transcript And Calendar System

| Doc | Use it for | Status |
| --- | --- | --- |
| [Transcript calendar coverage index](transcript-calendar-coverage-index.md) | Current calendar coverage, missing-session queue, candidate-review queue, and safe transcript metadata audit. | Generated safe metadata |
| [Transcript distillation playbook](transcript-distillation-playbook.md) | Process for turning raw/private transcript sources into reviewed cohort or public-safe artifacts. | Current process |
| [Reviewed transcript import map](reviewed-transcript-map.md) | Historical week 1/2 import map and older boundary decisions. | Historical reference |
| [Calendar transcript system map](calendar-transcript-system-map.html) | Visual system map for calendar, Drive, Supabase, and app-facing transcript surfaces. | Architecture reference |

## Calendar Ingress And Supabase

| Doc | Use it for | Status |
| --- | --- | --- |
| [Calendar Meet Supabase integration](calendar-meet-supabase-integration.md) | Architecture and integration notes for calendar capture, artifacts, and Supabase. | Current architecture reference |
| [Calendar ingress quality audit](calendar-ingress-quality-audit.md) | Risks and current quality findings for calendar ingestion. | Audit |
| [Calendar ingress launch checklist](calendar-ingress-launch-checklist.md) | Launch and operational readiness checklist. | Checklist |
| [Calendar ingress env example](calendar-ingress.env.example) | Environment-variable reference. | Example config |

## Product And Project Docs

| Doc | Use it for | Status |
| --- | --- | --- |
| [Install guide](INSTALL.md) | App installation and release instructions. | User-facing |
| [PR queue](PR_QUEUE.md) | Pull request and release queue notes. | Operational |
| [Maturity](MATURITY.md) | Product maturity framing. | Reference |
| [Matrix](MATRIX.md) | Project matrix reference. | Reference |
| [Swarm Atlas PRD](SWARM_ATLAS_PRD.md) | Swarm Atlas product requirements. | Product spec |

## Audits

Audit notes live under [audits/](audits/). Read [audits/README.md](audits/README.md) first because those files are fork/version-specific and should not all be treated as upstream product documentation.

## Maintenance Rules

- Keep durable docs in `docs/`; keep machine-readable policy in `cohort-data/policies/`.
- Mark generated docs with their generation date and source data.
- Mark historical docs explicitly at the top.
- Do not duplicate operating policy across multiple files. Link to [Information rules](INFORMATION_RULES.html) instead.
- Do not link durable docs to `tmp/` screenshots or private vault outputs.
