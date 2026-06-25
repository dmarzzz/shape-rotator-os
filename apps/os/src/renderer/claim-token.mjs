// claim-token.mjs — the device-local "soft identity" behind direct self-edit.
//
// docs/two-way-contribution-layer.md "Soft identity: claim-token": claiming a
// profile mints a local, opaque token. Cohort_events writes carry sha-256(token)
// as `claim_token_hash`, so the feed's "X updated…" attributions are trustworthy
// rather than spoofable, and a member's future agent has a credential to act as
// them rather than being indistinguishable from anonymous traffic.
//
// It is NOT hard auth (there are no member logins): it turns "anyone can edit
// anyone" into "you'd have to deliberately work around it," which at a 20–50
// member scale is plenty. The RAW token never leaves the device; only its hash is
// ever sent. Server-side enforcement of the hash is deliberately deferred (see the
// design doc) — at v0 the hash is recorded, not gate-checked.
//
// Kept standalone (no renderer imports) so it is pure + node-testable. identity.js
// wires mint-on-claim / clear-on-unclaim; the cohort_events emit sites read the hash.

const CLAIM_TOKEN_LS_KEY = "srwk:claim_token_v1";

function store(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

// 32 random bytes as hex. Uses the platform CSPRNG (present in Electron's renderer
// and in Node ≥ 18); the Math.random fallback only fires if getRandomValues is
// somehow absent — acceptable since this is a soft credential, not hard auth.
function mintToken() {
  const c = (() => { try { return globalThis.crypto; } catch { return null; } })();
  if (c && typeof c.getRandomValues === "function") {
    const bytes = new Uint8Array(32);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let s = "";
  for (let i = 0; i < 64; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// FNV-1a → 8 hex chars; only used if SubtleCrypto is unavailable (it isn't, in
// practice). Weak, but the value is opaque and the raw token stays local.
function fnvHex(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function sha256Hex(str) {
  const c = (() => { try { return globalThis.crypto; } catch { return null; } })();
  if (c && c.subtle && typeof c.subtle.digest === "function") {
    try {
      const data = new TextEncoder().encode(String(str));
      const buf = await c.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch { /* fall through */ }
  }
  return fnvHex(String(str));
}

function readToken(ls) {
  try {
    const raw = ls && ls.getItem(CLAIM_TOKEN_LS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || !v.token || !v.hash) return null;
    return v;
  } catch {
    return null;
  }
}

// Ensure a token exists; mint + persist one if not. Idempotent — returns the same
// { token, hash } on every call once minted. Async because hashing is async.
export async function ensureClaimToken(storage) {
  const ls = store(storage);
  const existing = readToken(ls);
  if (existing) return existing;
  const token = mintToken();
  const hash = await sha256Hex(token);
  const rec = { token, hash };
  try { ls && ls.setItem(CLAIM_TOKEN_LS_KEY, JSON.stringify(rec)); } catch { /* private mode */ }
  return rec;
}

// The hash to stamp on writes (sync). "" if not yet minted (unclaimed) so the
// emit path degrades to an anonymous, unverified event rather than breaking.
export function getClaimTokenHash(storage) {
  const rec = readToken(store(storage));
  return rec ? rec.hash : "";
}

// The raw token — a device-local credential for the member's future agent. Never
// sent over the wire. "" if not yet minted.
export function getClaimToken(storage) {
  const rec = readToken(store(storage));
  return rec ? rec.token : "";
}

export function clearClaimToken(storage) {
  const ls = store(storage);
  try { ls && ls.removeItem(CLAIM_TOKEN_LS_KEY); } catch { /* ignore */ }
}
