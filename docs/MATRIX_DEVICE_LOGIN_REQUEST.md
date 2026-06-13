# Request to the homeserver admin: enable "sign in with another device"

**Audience:** whoever administers the cohort homeserver `mtrx.shaperotator.xyz` (Synapse).

**The ask, in one line:** turn on a **client rendezvous endpoint** so a device
that's already logged in (e.g. Element on a phone) can approve a new device via
QR — the "sign in with another device" flow. That's the one missing server
piece; everything else is already in place.

---

## Why we need this

The Shape Rotator OS desktop app has a `matrix` tab that reads and posts in the
cohort channels. We do **not** want it to collect people's Matrix passwords —
typing your password into a third-party desktop app is exactly the phishing
pattern we should avoid.

The clean, password-free way to log in is **device approval**: the app shows a
QR code, the user scans it with the Matrix client they're already signed into
(Element on their phone), approves it there, and the app receives a session.
The password only ever lives where it already does — in the user's existing
trusted client. This is the standard Matrix "sign in with another device" /
"login with QR" flow (Element X uses it by default).

## What's already working on the server (verified)

```
$ curl https://mtrx.shaperotator.xyz/_matrix/client/v3/login
{"flows":[{"type":"m.login.password"},
          {"type":"m.login.application_service"},
          {"type":"m.login.token","get_login_token":true}]}     ← get_login_token: true ✓

$ curl -X POST https://mtrx.shaperotator.xyz/_matrix/client/v1/login/get_token
401 Missing access token        ← endpoint EXISTS (an authed session can mint a login token) ✓
```

So the homeserver can already do the important half: an authenticated device
can mint a short-lived login token for another device. Good.

## What's missing (this is the whole request)

```
$ curl -X POST https://mtrx.shaperotator.xyz/_matrix/client/v1/rendezvous   → 404
$ curl -X POST https://mtrx.shaperotator.xyz/_synapse/client/rendezvous      → 404
$ curl https://mtrx.shaperotator.xyz/_matrix/client/versions | grep -i 4108  → (nothing)
```

There is **no rendezvous endpoint**. The rendezvous is the short-lived relay the
two devices use to find each other and hand over the login token after the QR
is scanned. Without it, QR device-linking cannot work — there's no channel for
the phone and the app to talk through.

**So: please enable a client rendezvous endpoint.** Two ways, pick whichever
fits your Synapse version / auth setup:

### Option A — MSC4108 (current standard, Element-X compatible) — preferred

This is the modern, ECDH-secured rendezvous. In recent Synapse it's part of the
next-gen auth stack and is typically turned on alongside **Matrix
Authentication Service (MAS)**. If you're already considering MAS, this gets us
QR login *and* OAuth-style browser login in one move. Please enable the MSC4108
rendezvous (and tell us the resulting rendezvous URL the homeserver advertises).

### Option B — MSC3886 native rendezvous (lighter, no MAS) — fallback

If you're not deploying MAS, the older standalone rendezvous may still be
available in your Synapse version. Roughly:

```yaml
# homeserver.yaml
experimental_features:
  msc3886_endpoint: "/_synapse/client/rendezvous"
```

⚠️ MSC3886 was experimental and may be removed in newer Synapse releases —
please confirm it still exists in your version. If it's gone, Option A (MSC4108
/ MAS) is the path.

Either way, **`get_login_token` is already enabled**, so no change is needed
there.

## How to verify it's live (and how the app detects it)

After enabling, this should stop 404-ing:

```
$ curl -i -X POST https://mtrx.shaperotator.xyz/<rendezvous-path>
# expect 201 Created (with a Location header), not 404
```

Tell us the exact rendezvous URL/path. The app feature-detects it and will then
show "Sign in with another device" instead of a password box.

## What you do NOT need to do

- **No E2EE / cross-signing work.** Our v1 reads/writes unencrypted channels
  only; we're not asking for encrypted-room support yet.
- **No changes to existing accounts.** People keep their current
  `@name:mtrx.shaperotator.xyz` accounts and passwords — this only adds a way to
  *log a new device in* by approving from an existing one.
- **No app credentials on the server.** The app holds no shared secret; each
  user's own device does the approving.

## If rendezvous is impractical right now

A lighter alternative that *also* gives password-free login (different UX — a
"sign in in your browser" button instead of a QR) is to enable **SSO/OIDC**
(e.g. GitHub or Google as the identity provider). That's a smaller config change
and the app already supports it. Details: [MATRIX_OIDC_SETUP.md](MATRIX_OIDC_SETUP.md).

## TL;DR for the admin

1. Enable a **client rendezvous endpoint** (MSC4108 preferred, MSC3886 as a
   no-MAS fallback — confirm what your Synapse version supports).
2. `get_login_token` is already on — leave it.
3. Send us the **rendezvous URL/path**; the app does the rest.
4. Nothing about existing accounts, passwords, or E2EE changes.
