---
record_id: shape-rotator-os-teleport-router
record_type: dependency
schema_version: 1
source: shape-rotator-os
target: teleport-router
relation: depends_on
status: declared
confidence: medium
reason: Shape Rotator OS can consume Teleport Router's shared-notebook / cross-pollination feed (exposed as a plain REST API) instead of reimplementing the cohort introduction pipeline; the OS already lists teleport-router as a dependency and the router is the first cohort project merged into the OS.
evidence:
  - "Shape Rotator OS focus: cohort coordination layer; offering: a merge target for cohort-project integrations"
  - "Shape Rotator OS already lists teleport-router in its declared dependencies"
  - "Teleport Router traction: first merged cohort-project contribution to Shape Rotator OS"
  - "Teleport Router offering: cross-network routing primitives and a cross-pollination feed"
next_action: Confirm whether the OS has wired a reader against the router's REST notebook feed; if not yet built, scope the integration and resolve the open privacy-boundary decision on published intros before the OS surfaces notebook entries.
owner: shape-rotator-os
updated_at: 2026-06-14
---

## source

Consumer-of-substrate relationship grounded in public team fields (the OS's declared dependency on teleport-router plus the router's public traction of a merged OS contribution). The REST-feed-consumption framing was surfaced in reviewed cohort session notes; it describes an intended capability, not a confirmed shipped integration.
