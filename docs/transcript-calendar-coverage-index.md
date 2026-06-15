# Transcript Calendar Coverage Index

Generated: 2026-06-14T00:10:00.436Z
Audit date: 2026-06-14
Calendar source refresh: 2026-06-13T16:12:46.618673+00:00

Related: [Docs hub](README.md) · [Transcript source index](INFORMATION_INDEX.html) · [Information rules](INFORMATION_RULES.html)

This index lists every expanded calendar block from `cohort-data/calendar.json` and records whether a transcript source, reviewed readout, or candidate source exists. It uses metadata only; it does not read or publish raw transcript text.

The detailed transcript filename/original-name queue is private at `cohort-data/.private/transcript-vault/transcript-calendar-coverage-audit.md` because some source titles disclose private coaching, fundraising, or strategy context.

## Summary

- Calendar blocks indexed: 97
- Past/current transcript-expected blocks: 28
- Missing transcript-expected blocks: 9
- Blocks with candidates needing review: 4
- Transcript vault refs audited: 42
- Source artifacts ready for worker queue: 9
- Private sources fetched locally: 9
- Safe Drive names/routes verified: 26
- Manual reviewed Drive corrections applied: 1
- Reviewed session readouts found: 12
- Transcript naming/metadata issue rows: 28
- Calendar title issue rows: 0

## Coverage Counts

| Status | Count |
| --- | ---: |
| candidate_needs_review | 4 |
| covered | 7 |
| covered_not_required | 1 |
| derived_readout | 9 |
| future | 35 |
| missing | 9 |
| not_expected | 32 |

## Expectation Counts

| Expectation | Count |
| --- | ---: |
| expected | 25 |
| expected_private | 3 |
| future | 35 |
| not_expected | 33 |
| optional | 1 |

## Transcript Source Audit Counts

- Vault import plan generated: 2026-06-13T23:03:19.178Z
- Session map generated: 2026-06-13T21:12:44.974Z
- Vault files in import plan: 43
- Transcript files in import plan: 42
- Calendar matched transcript files: 13
- Date-only transcript files: 26
- Title-only transcript candidates: 1
- Date-conflict transcript candidates: 1
- Unknown-date transcript files: 2
- Transcript refs needing manual review: 30
- Safe session links: 9
- Review session links: 8
- Rename recommended by import plan: 16
- Drive rename actions planned: 16
- Drive move actions planned: 43
- Drive file operations safe to apply: 21
- Drive file operations held for review: 22
- Last safe Drive apply: 0 updated, 25 unchanged

## Missing Required Sessions

| Date | Time | Calendar title | Expectation | Coverage | Evidence | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-05-18 | 12:00-14:00 | onboarding | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-18 | 14:30-17:00 | onboarding (cont'd) | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-19 | 19:00-19:30 | Founder night - Carter Cleveland | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-21 | 14:30-16:00 | More onboarding & on-site registration | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-28 | 16:00-18:30 | Agentic Tooling workshops/clinic | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-29 | 14:30-15:30 | router onboarding/workshop | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-06-09 | 16:30-19:30 | (private — title withheld) | expected_private | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-06-10 | 16:30-17:00 | Team-led sessions | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-06-12 | 16:30-19:30 | Internal ETH NY product review \| Demo review + hackathon team goal-setting. | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |

## Candidate Sessions Needing Review

| Date | Time | Calendar title | Expectation | Coverage | Evidence | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-05-25 | 16:00-17:30 | (private — title withheld) | expected_private | candidate_needs_review | private vault candidate (review pending) | Review session/date match and policy route before queueing processing. |
| 2026-05-27 | 14:00-15:30 | (James, Andrew) Onboarding for teleport router, q&a | expected | candidate_needs_review | rd_jam_dstack-alex-shaw-lsdan-andrew_2026-05-27.txt (manual_review) | Review session/date match and policy route before queueing processing. |
| 2026-06-09 | 20:00-22:30 | Info Markets Design | expected | candidate_needs_review | salon_info-markets-design-b2b_2026-01-10.txt (manual_review) | Review session/date match and policy route before queueing processing. |
| 2026-06-11 | 15:30-16:30 | (private — title withheld) | expected_private | candidate_needs_review | user_interview_inference_unknown-date.txt (manual_review) | Review session/date match and policy route before queueing processing. |

## Calendar Title Audit

| Date | Time | Calendar title | Issue | Detail |
| --- | --- | --- | --- | --- |
|  |  |  | none | No title issues detected by the audit heuristics. |

## Complete Calendar Coverage

| Date | Time | Calendar title | Expectation | Coverage | Evidence | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-05-18 | 12:00-14:00 | onboarding | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-18 | 14:00-14:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-18 | 14:30-17:00 | onboarding (cont'd) | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-18 | 19:30-20:00 | kickoff dinner @ Auditorium | not_expected | not_expected |  | No transcript expected. |
| 2026-05-19 | 14:00-14:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-19 | 16:00-19:00 | Project intros&workflow | expected | derived_readout | cohort-data/session-readouts/day1-project-intros-notes-2026-05-19.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-19 | 19:00-19:30 | Founder night - Carter Cleveland | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-20 | 12:00-14:00 | Tutorial: Dstack | expected | derived_readout | salon_dstack-intro_2026-05-20.txt (review_link)<br>cohort-data/session-readouts/dstack-intro-salon-2026-05-20.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-20 | 14:00-14:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-20 | 16:00-19:00 | Project Intros (Salon room) | expected | covered | demo_presentation_local-first_2026-05-20.txt (safe_link)<br>salon_dstack-intro_2026-05-20.txt (review_link)<br>cohort-data/session-readouts/project-intros-local-private-first-phil-2026-05-20.md<br>cohort-data/session-readouts/dstack-intro-salon-2026-05-20.md | No transcript action; continue review/publish flow if needed. |
| 2026-05-20 | 19:00-19:30 | Founder's journey (Auditorium) | expected | derived_readout | cohort-data/session-readouts/project-intros-local-private-first-phil-2026-05-20.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-21 | 12:00-14:00 | Tutorial: Dumb agent tricks, install hermes | expected | covered | rd_jam_dumb-agent-tricks_2026-05-21.txt (safe_link)<br>cohort-data/session-readouts/dumb-agent-tricks-2026-05-21.md | No transcript action; continue review/publish flow if needed. |
| 2026-05-21 | 14:00-14:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-21 | 14:30-16:00 | More onboarding & on-site registration | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-21 | 16:00-18:00 | Project Intros: Agentic | expected | derived_readout | cohort-data/session-readouts/project-intros-agents-day3-2026-05-21.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-21 | 18:00-19:00 | Yoga | not_expected | not_expected |  | No transcript expected. |
| 2026-05-22 | 06:30-07:00 | PMF Roast w/ Tina and Greg The Greek | expected | derived_readout | salon_friday-shaw-greg_2026-05-22.txt (review_link)<br>cohort-data/session-readouts/friday-shaw-greg-2026-05-22.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-22 | 07:30-09:00 | Founders Journey w/ Shaw | expected | derived_readout | salon_friday-shaw-greg_2026-05-22.txt (review_link)<br>cohort-data/session-readouts/friday-shaw-greg-2026-05-22.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-22 | 14:00-14:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-22 | 17:15-18:30 | Introduce Tina + interactive recap / Project Mappings | optional | covered | salon_shape-rotator-project-map-guests_2026-05-22.txt (safe_link)<br>cohort-data/session-readouts/shape-rotator-project-map-guests-2026-05-22.md | No transcript action; continue review/publish flow if needed. |
| 2026-05-25 | all day | Memorial Day | not_expected | not_expected |  | No transcript expected. |
| 2026-05-25 | 16:00-17:30 | (private — title withheld) | expected_private | candidate_needs_review | private vault candidate (review pending) | Review session/date match and policy route before queueing processing. |
| 2026-05-25 | 19:00-19:30 | muse dinner | not_expected | not_expected |  | No transcript expected. |
| 2026-05-26 | 14:30-15:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-26 | 15:00-17:00 | Project Intros: Elocute, Dealproof, Wikigen, Crossroads | expected | derived_readout | demo_presentation_wikigen-crossroads_2026-05-26.txt (review_link)<br>demo_presentation_elocute_2026-05-26.txt (review_link)<br>office_hours_elocute-product-shaw_2026-05-26.txt (review_link)<br>cohort-data/session-readouts/wikigen-crossroads-gil-pmf-2026-05-26.md<br>cohort-data/session-readouts/elocute-2026-05-26.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-26 | 18:00-19:30 | Lecture - Defining Product Market Fit | expected | derived_readout | office_hours_elocute-product-shaw_2026-05-26.txt (review_link)<br>cohort-data/session-readouts/wikigen-crossroads-gil-pmf-2026-05-26.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-26 | 19:30-20:00 | Community Dinner in auditorium (Chef Matt presents) | not_expected | not_expected |  | No transcript expected. |
| 2026-05-27 | 14:00-15:30 | (James, Andrew) Onboarding for teleport router, q&a | expected | candidate_needs_review | rd_jam_dstack-alex-shaw-lsdan-andrew_2026-05-27.txt (manual_review) | Review session/date match and policy route before queueing processing. |
| 2026-05-27 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-27 | 16:00-17:30 | Salon: Ideal Customer Profiling, User Interviews (James) | expected | derived_readout | cohort-data/session-readouts/icp-user-interviews-2026-05-27.md | Source readout exists; verify raw source link if full source coverage is required. |
| 2026-05-27 | 18:00-19:30 | Flashnet jam (Dmarz) | expected | covered | rd_jam_flashnet-part-1-of-3_2026-05-27.txt (safe_link)<br>rd_jam_flashnet-part-2-of-3_2026-05-27.txt (safe_link)<br>rd_jam_flashnet-part-3-of-3_2026-05-27.txt (safe_link) | No transcript action; continue review/publish flow if needed. |
| 2026-05-27 | 19:30-21:00 | low key dinner (auditorium) | not_expected | not_expected |  | No transcript expected. |
| 2026-05-28 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-28 | 16:00-18:30 | Agentic Tooling workshops/clinic | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-29 | 14:30-15:30 | router onboarding/workshop | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-05-29 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-05-29 | 19:00-19:30 | sorting hat dinner (Tina) | not_expected | covered_not_required | salon_shape-rotator-cohort-dinner-sorting-hat-dinner_2026-05-29.txt (safe_link) | Transcript exists for a non-required block; keep policy boundary explicit before surfacing. |
| 2026-05-30 | all day | Convent | not_expected | not_expected |  | No transcript expected. |
| 2026-06-01 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-02 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-03 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-04 | all day | Thu — group activity, sculpture garden | not_expected | not_expected |  | No transcript expected. |
| 2026-06-05 | all day | Fri — reception at art museum (overlap w/ shaperotator) | not_expected | not_expected |  | No transcript expected. |
| 2026-06-07 | 09:00-09:30 | Eth Global hackathon due | not_expected | not_expected |  | No transcript expected. |
| 2026-06-08 | 11:30-13:00 | Agentic Organizations with Sreeram @EigenLabs | expected | covered | salon_agentic-organizations-sreeram_2026-06-08.txt (safe_link) | No transcript action; continue review/publish flow if needed. |
| 2026-06-08 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-08 | 16:00-17:00 | WDYDLW with Shaw as Moderator @ the auditorium | expected | covered | weekly_standup_shaw_2026-06-08.txt (safe_link) | No transcript action; continue review/publish flow if needed. |
| 2026-06-09 | 15:30-16:00 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-09 | 16:30-19:30 | (private — title withheld) | expected_private | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-06-09 | 20:00-22:30 | Info Markets Design | expected | candidate_needs_review | salon_info-markets-design-b2b_2026-01-10.txt (manual_review) | Review session/date match and policy route before queueing processing. |
| 2026-06-10 | all day | Anarchy Day protected build time. No Shape Rotator programming. | not_expected | not_expected |  | No transcript expected. |
| 2026-06-10 | 16:00-16:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-10 | 16:30-17:00 | Team-led sessions | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-06-11 | 15:30-16:30 | (private — title withheld) | expected_private | candidate_needs_review | user_interview_inference_unknown-date.txt (manual_review) | Review session/date match and policy route before queueing processing. |
| 2026-06-11 | 16:00-16:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-11 | 16:30-19:30 | Design Thinking Workshop | expected | covered | salon_design-thinking-workshop_2026-06-11.txt (safe_link) | No transcript action; continue review/publish flow if needed. |
| 2026-06-11 | 19:30-22:30 | Open Jams / Muse Dinner \| Hackathon team open jams + dinner at the Convent. | not_expected | not_expected |  | No transcript expected. |
| 2026-06-12 | all day | Friday night > Hacking begins \| At the ETH NY venue or the Convent. | not_expected | not_expected |  | No transcript expected. |
| 2026-06-12 | 16:00-16:30 | tea on roof | not_expected | not_expected |  | No transcript expected. |
| 2026-06-12 | 16:30-19:30 | Internal ETH NY product review \| Demo review + hackathon team goal-setting. | expected | missing |  | Find source transcript/recording or mark explicitly unavailable. |
| 2026-06-13 | all day | All day / night Build | not_expected | not_expected |  | No transcript expected. |
| 2026-06-13 | all day | Ship something used. ETH NY venue or the Convent. | not_expected | not_expected |  | No transcript expected. |
| 2026-06-15 | all day | Mon-Tue: TEE Technical - AI and LLM Inference | future | future |  | Future session; check after it happens. |
| 2026-06-16 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-06-17 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-06-19 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-06-20 | all day | Convent | future | future |  | Future session; check after it happens. |
| 2026-06-22 | all day | Mon-Tue: Lecture: Go-to-Market (Eshita Nandini) | future | future |  | Future session; check after it happens. |
| 2026-06-23 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-06-24 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-06-25 | all day | Thu-Fri: Salon: Content and Marketing (Liz, Albi) | future | future |  | Future session; check after it happens. |
| 2026-06-26 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-06-27 | all day | Convent | future | future |  | Future session; check after it happens. |
| 2026-06-29 | all day | Mon-Tue: Lecture: Legal and Policy (speaker via Gil) | future | future |  | Future session; check after it happens. |
| 2026-06-30 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-01 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-02 | all day | Thu-Fri: Cohort Builds itself Demo Day | future | future |  | Future session; check after it happens. |
| 2026-07-03 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-04 | all day | Convent + Cornell Tech | future | future |  | Future session; check after it happens. |
| 2026-07-06 | all day | Mon-Tue: Lecture: Fundraising + Incentive Design (speakers via Gil) | future | future |  | Future session; check after it happens. |
| 2026-07-07 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-08 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-09 | all day | Thu-Fri: TEE Technical: P2P and Self-Host Day (dmarz et al.) | future | future |  | Future session; check after it happens. |
| 2026-07-10 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-11 | all day | Convent + Cornell Tech | future | future |  | Future session; check after it happens. |
| 2026-07-13 | all day | Mon-Tue: People Ops + Business Development | future | future |  | Future session; check after it happens. |
| 2026-07-14 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-15 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-16 | all day | Thu-Fri: Pitch practice + VC intros | future | future |  | Future session; check after it happens. |
| 2026-07-17 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-18 | all day | Convent + Cornell Tech · Sat Jul 18 (Andrew → Berlin) | future | future |  | Future session; check after it happens. |
| 2026-07-20 | all day | Mon-Tue: Convergence: investor + partner feedback · Final product polish | future | future |  | Future session; check after it happens. |
| 2026-07-21 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-22 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-23 | all day | Thu-Fri: **Final Demo Day #2 (Thu Jul 23 or Fri Jul 24)** | future | future |  | Future session; check after it happens. |
| 2026-07-24 | 15:30-16:00 | tea on roof | future | future |  | Future session; check after it happens. |
| 2026-07-25 | all day | Convent + Cornell Tech · Demo Day weekend | future | future |  | Future session; check after it happens. |

## Operating Notes

- `covered` means a private transcript/source artifact is linked strongly enough to process or already queued in the source-artifact plan.
- `derived_readout` means a reviewed readout exists, but the current source-link plan does not prove a ready raw source artifact for this exact calendar block.
- `candidate_needs_review` means metadata found a plausible transcript, but title/date/session matching or policy routing still needs human review.
- `missing` means the session is past/current, transcript-expected, and no current source/readout/candidate proves coverage.
- `future` means the calendar block occurs after the audit date and should be checked after it happens.
- `not_expected` covers tea, dinners, social blocks, hackathon build time, holidays, and other blocks where transcript capture is not expected by default.
- `Safe Drive names/routes verified` means the safe rename/move set was checked against live Google Drive. `Transcript naming/metadata issue rows` can still include verified files when their calendar/session metadata needs review.
- The audit does not mutate Google Drive. Use the private Drive operations plan for reviewed renames/moves; apply only after confirming held-review rows.
