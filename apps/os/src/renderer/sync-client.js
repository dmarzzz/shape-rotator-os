// sync-client.js — renderer-side talker for the local bundled swf-node's
// Phase 2 /sync/* endpoints (spec: SYNC.md on docs/phase-2-sync-spec
// branch of dmarzzz/searxng-wth-frnds, §4 + §7).
//
// What this module does:
//   - GET  /sync/manifest                → list this node's records (live view)
//   - GET  /sync/record/<id>             → one record's envelope chain
//   - POST /sync/local_record            → push a freshly-authored profile
//                                          edit; agent-bearer-gated.
//   - GET  /health                       → check forked_records (spec §9.9)
//
// What this module is NOT:
//   - It doesn't sign envelopes. swf-node owns the Ed25519 identity key
//     (~/.config/swf/identity.key, per spec §8.4); it's the only entity
//     that can sign. The renderer ships {record_id, kind, content,
//     prev_hash} and lets swf-node compute the wall_ts_ms, content_hash,
//     prev_hash chain, and signature server-side. See callsite in
//     alchemy.js submitEditAsPR (EDIT/ADD modes) — the existing PR-based
//     fallback handles the case where swf-node is unavailable.
//   - It doesn't poll. The cohort-source.js layer merges /sync/manifest
//     records over the cohort-data/*.md baseline on its own 30s tick.
//
// All requests have a 5s timeout. Network errors / non-200 responses
// surface as `{ ok: false, reason }` so call sites can fall back cleanly
// (the legacy github-PR path keeps working on Windows + first launches
// + any other "swf-node unreachable" scenario).

// Base URL — pinned to loopback (the bundled daemon binds to 0.0.0.0
// but the renderer always reaches it via 127.0.0.1). Override via the
// existing env:get IPC if a dev points the renderer at a remote daemon.
const DEFAULT_BASE = "http://127.0.0.1:7777";
const REQUEST_TIMEOUT_MS = 5000;

let _baseUrl = DEFAULT_BASE;
let _tokenCache = null;
let _tokenFetchedAt = 0;
const TOKEN_TTL_MS = 60 * 1000;  // re-ask main every minute in case the daemon was restarted

// Allow boot.js / dev tools to point this at a non-default daemon. We
// don't auto-resolve via env:get here because that would force every
// callsite to await the env handshake.
export function setBaseUrl(url) {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) _baseUrl = url;
}
export function getBaseUrl() { return _baseUrl; }

// Pull the agent bearer from main (apps/os/main.js's fg:swf-agent-token
// handler, backed by apps/os/swf-node.js's persisted token file). Cached
// briefly so we don't IPC-bounce on every request. Returns null if main
// reports "no token" — that's the "swf-node unavailable / Windows /
// SWF_NODE_DISABLE=1" path; callers treat it as "unreachable" too.
async function getAgentToken({ force = false } = {}) {
  const now = Date.now();
  if (!force && _tokenCache && (now - _tokenFetchedAt) < TOKEN_TTL_MS) {
    return _tokenCache;
  }
  try {
    const tok = await window.api?.getSwfAgentToken?.();
    if (typeof tok === "string" && tok) {
      _tokenCache = tok;
      _tokenFetchedAt = now;
      return tok;
    }
  } catch {
    // IPC failure — treat as no token; sync-client will fail and the
    // caller falls back to the github PR path.
  }
  _tokenCache = null;
  _tokenFetchedAt = now;
  return null;
}

// Reset the token cache. Used by the self-test path so a recently
// restarted swf-node doesn't get a stale token.
export function _clearTokenCache() {
  _tokenCache = null;
  _tokenFetchedAt = 0;
}

// Wrap fetch with an AbortController-backed timeout. Resolves with a
// `{ ok, status, json | text | error, reason }` envelope so call sites
// don't have to juggle try/catch around network + parse errors.
async function timedFetch(url, init = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const status = res.status;
    let body = null;
    let bodyText = null;
    try { bodyText = await res.text(); } catch {}
    if (bodyText) {
      try { body = JSON.parse(bodyText); }
      catch { body = null; }
    }
    if (!res.ok) {
      return {
        ok: false,
        status,
        reason: status === 401 ? "unauthorized"
              : status === 404 ? "not_found"
              : status === 409 ? "conflict"
              : status === 413 ? "envelope_too_large"
              : status >= 500 ? "server_error"
              : "http_error",
        body,
        text: bodyText,
      };
    }
    return { ok: true, status, body, text: bodyText };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /aborted/i.test(e.message || ""));
    return {
      ok: false,
      status: 0,
      reason: aborted ? "timeout" : "network",
      error: e && (e.message || String(e)),
    };
  } finally {
    clearTimeout(t);
  }
}

// ─── public API ────────────────────────────────────────────────────────

/**
 * GET /sync/manifest.
 *
 * Returns the local swf-node's view of every record it holds — the
 * cohort-wide "live view" of profiles. Response shape per spec §4.1:
 *
 *   {
 *     schema, node_pubkey, generated_at_ms,
 *     records: { <record_id>: { kind, author_pubkey,
 *                               latest_content_hash, latest_wall_ts_ms } },
 *     manifest_hash
 *   }
 *
 * On success returns `{ ok: true, manifest }`. On failure returns
 * `{ ok: false, reason }` (reasons: timeout, network, server_error,
 * http_error). Cohort-source.js treats any non-ok result as "swf-node
 * unreachable" and falls back to the cohort-data/*.md baseline.
 */
export async function getManifest() {
  const url = `${_baseUrl}/sync/manifest`;
  const res = await timedFetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status, error: res.error };
  if (!res.body || typeof res.body !== "object" || !res.body.records) {
    return { ok: false, reason: "malformed", status: res.status };
  }
  return { ok: true, manifest: res.body };
}

/**
 * GET /sync/record/<record_id>.
 *
 * By default returns just the newest envelope (LWW view). Pass
 * `{ full: true }` to fetch the full chain newest-first (spec §4.2 with
 * `since=0` + max limit — used by the history modal).
 *
 * On success returns `{ ok: true, envelopes, more }`. The newest is
 * index 0. On 404 returns `{ ok: false, reason: "not_found" }` so the
 * caller can render "no record yet" without escalating.
 */
export async function getRecord(recordId, { full = false, since, limit } = {}) {
  if (!recordId || typeof recordId !== "string") {
    return { ok: false, reason: "bad_request", error: "recordId required" };
  }
  const params = new URLSearchParams();
  if (full) {
    // limit=1000 covers the cohort-math worst case (50 members × 100 edits
    // each from §7.1). For records past that the caller would paginate.
    params.set("since", "0");
    params.set("limit", "1000");
  } else {
    if (typeof since === "number") params.set("since", String(since));
    if (typeof limit === "number") params.set("limit", String(limit));
    else params.set("limit", "1");   // newest-only view
  }
  const qs = params.toString();
  const url = `${_baseUrl}/sync/record/${encodeURIComponent(recordId)}${qs ? `?${qs}` : ""}`;
  const res = await timedFetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status, error: res.error };
  if (!res.body || !Array.isArray(res.body.envelopes)) {
    return { ok: false, reason: "malformed", status: res.status };
  }
  return { ok: true, envelopes: res.body.envelopes, more: !!res.body.more, warnings: res.body.warnings || [] };
}

/**
 * POST /sync/local_record.
 *
 * Submit a freshly-authored record. swf-node owns the identity key
 * (per spec §8.4), so the renderer hands over the writeable fields and
 * swf-node fills in wall_ts_ms, content_hash, prev_hash chain, and
 * signature. See spec §7.4 (option A — confirmed in §9.5).
 *
 * Required body fields:
 *   record_id   (string, [a-z0-9._-]+, 1..128)
 *   record_type (string, the envelope's `kind` — Phase 2 ships "person")
 *   content     (object — the surface fields the user typed in the editor)
 * Optional:
 *   prev_hash   (string sha256:<hex> | null). If omitted the daemon
 *               infers it from the existing chain; passing it explicitly
 *               is a defensive consistency check (caller-observed
 *               latest_content_hash → daemon-observed latest_content_hash).
 *
 * Auth: Bearer ${SWF_AGENT_TOKEN}. The token is loaded lazily from main
 * via the fg:swf-agent-token IPC; if no token is available, returns
 * `{ ok: false, reason: "no_token" }` and the caller falls back to the
 * github PR path.
 *
 * On success returns `{ ok: true, envelope }` — the signed envelope as
 * swf-node accepted it, so the caller can stamp the new latest into the
 * in-memory cohort surface without waiting for the next sync tick.
 */
export async function putLocalRecord({ record_id, record_type, content, prev_hash } = {}) {
  if (!record_id || typeof record_id !== "string") {
    return { ok: false, reason: "bad_request", error: "record_id required" };
  }
  if (!record_type || typeof record_type !== "string") {
    return { ok: false, reason: "bad_request", error: "record_type required" };
  }
  if (!content || typeof content !== "object") {
    return { ok: false, reason: "bad_request", error: "content (object) required" };
  }
  const token = await getAgentToken();
  if (!token) return { ok: false, reason: "no_token" };

  const url = `${_baseUrl}/sync/local_record`;
  const body = {
    record_id,
    record_type,
    content,
  };
  if (prev_hash !== undefined) body.prev_hash = prev_hash;

  const res = await timedFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // On 401 force-refresh the token cache once — the daemon may have
    // restarted with a different token (e.g. someone manually edited
    // the agent_token file). One retry; if it still fails the renderer
    // falls back to the github PR path.
    if (res.reason === "unauthorized") {
      _clearTokenCache();
      const fresh = await getAgentToken({ force: true });
      if (fresh && fresh !== token) {
        const retry = await timedFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${fresh}`,
          },
          body: JSON.stringify(body),
        });
        if (retry.ok && retry.body && retry.body.envelope) {
          return { ok: true, envelope: retry.body.envelope };
        }
        return { ok: false, reason: retry.reason || "unauthorized", status: retry.status, body: retry.body };
      }
    }
    return { ok: false, reason: res.reason, status: res.status, body: res.body };
  }
  // Spec §7.4 doesn't pin the response shape. We expect the daemon to
  // echo `{ envelope: <signed envelope> }`. Be defensive about the wrap.
  const envelope = res.body?.envelope || (res.body?.magic === "swf-sync-v1" ? res.body : null);
  if (!envelope) {
    return { ok: false, reason: "malformed", status: res.status, body: res.body };
  }
  return { ok: true, envelope };
}

/**
 * GET /sync/log?since_seq=<int>&limit=<int>.
 *
 * Returns the local swf-node's incremental sync-event log (one event
 * per sync-loop side effect: ticks, manifest_fetched, pulled,
 * applied_local, peer_unreachable, peer_reachable). Response shape per
 * swf-node Phase 2 spec extension (swf.sync.log.v1):
 *
 *   {
 *     schema: "swf.sync.log.v1",
 *     node_pubkey: "<own pubkey>",
 *     tail_seq: <int>,
 *     events: [ { seq, kind, ts_ms, ... }, ... ]
 *   }
 *
 * Caller polls with `since_seq=<last_seen>` to receive only events with
 * `seq > since_seq`. On success returns `{ ok: true, log }`. On 404 the
 * endpoint is unavailable (older swf-node) — returns `{ ok: false,
 * reason: "not_found" }` so the renderer can disable the feature
 * cleanly without crashing. Other failure modes mirror getManifest().
 */
export async function getSyncLog({ sinceSeq = 0, limit = 100 } = {}) {
  const params = new URLSearchParams();
  params.set("since_seq", String(sinceSeq));
  params.set("limit", String(limit));
  const url = `${_baseUrl}/sync/log?${params.toString()}`;
  const res = await timedFetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status, error: res.error };
  if (!res.body || typeof res.body !== "object" || !Array.isArray(res.body.events)) {
    return { ok: false, reason: "malformed", status: res.status };
  }
  return { ok: true, log: res.body };
}

/**
 * GET /health.
 *
 * Used by the fork-warning poll (spec §9.9). Returns the parsed body
 * directly when ok; the caller looks for `forked_records` (or whatever
 * key the Phase 2 A agent ends up using — both /health and
 * /sync/manifest are candidates per the task description, we hit
 * /health first because it's the cheaper probe).
 */
export async function getHealth() {
  const url = `${_baseUrl}/health`;
  const res = await timedFetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) return { ok: false, reason: res.reason, status: res.status };
  return { ok: true, body: res.body || {} };
}

/**
 * Convenience probe: is the local swf-node reachable AND can we auth?
 * Returns one of "ready" | "unreachable" | "no_token". Used by alchemy.js
 * to decide whether to route submit through sync vs the github PR
 * fallback.
 */
export async function probe() {
  const m = await getManifest();
  if (!m.ok) return m.reason === "no_token" ? "no_token" : "unreachable";
  const tok = await getAgentToken();
  if (!tok) return "no_token";
  return "ready";
}

// ─── dev-only smoke test ───────────────────────────────────────────────
// Calls getManifest() against the bundled swf-node, dumps the result to
// console, returns a serializable summary. Bind a hotkey or call it
// from devtools (window.__srfgSyncClientSelfTest()) or via main-process
// IPC `fg:sync-client-selftest`.
async function selfTest() {
  const started = performance.now();
  console.group("[sync-client] selftest");
  console.log("base url:", _baseUrl);
  const tokenOk = !!(await getAgentToken({ force: true }));
  console.log("agent token from main:", tokenOk ? "present" : "MISSING");
  const m = await getManifest();
  console.log("GET /sync/manifest →", m);
  let recordsCount = 0;
  let firstRecordId = null;
  let recordResult = null;
  if (m.ok) {
    const ids = Object.keys(m.manifest?.records || {});
    recordsCount = ids.length;
    firstRecordId = ids[0] || null;
    if (firstRecordId) {
      recordResult = await getRecord(firstRecordId);
      console.log(`GET /sync/record/${firstRecordId} (newest only) →`, recordResult);
    }
  }
  const h = await getHealth();
  console.log("GET /health →", h);
  const elapsed = Math.round(performance.now() - started);
  const summary = {
    ok: !!m.ok,
    base_url: _baseUrl,
    has_agent_token: tokenOk,
    manifest_records: recordsCount,
    first_record_id: firstRecordId,
    sampled_record_ok: recordResult ? recordResult.ok : null,
    health_ok: h.ok,
    elapsed_ms: elapsed,
    manifest_reason: m.ok ? null : m.reason,
  };
  console.log("summary:", summary);
  console.groupEnd();
  return summary;
}

// Expose on `window` for devtools access; also reachable from main via
// fg:sync-client-selftest IPC. The `__srfg` prefix matches the rest of
// the renderer's debug hooks (cohort-source dev override, etc.).
if (typeof window !== "undefined") {
  window.__srfgSyncClientSelfTest = selfTest;
}
