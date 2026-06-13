# Password-free sign-in for Shape Rotator OS (Matrix)

**Status: no homeserver change required — built and working client-side.**

The OS app (`matrix` tab) signs people in **without ever collecting their
password**. It uses the Matrix login-token flow (MSC3882), which the cohort
homeserver `mtrx.shaperotator.xyz` already supports.

> Note: that homeserver runs **continuwuity** (a conduwuit fork), not Synapse —
> so there's no MAS/OIDC and no `homeserver.yaml` to edit. An earlier draft of
> this doc assumed Synapse; ignore that. [MATRIX_OIDC_SETUP.md](MATRIX_OIDC_SETUP.md)
> is Synapse-only and does **not** apply to the current server.

## How it works

Two server calls, neither of which touches the app with a password:

1. **A device you're already signed in to mints a short-lived (~2 min) token:**
   ```
   POST /_matrix/client/v1/login/get_token      (Authorization: Bearer <existing session token>)
   → { "login_token": "...", "expires_in_ms": 120000 }
   ```
2. **The app redeems it for its own fresh device session:**
   ```
   POST /_matrix/client/v3/login   { "type": "m.login.token", "token": "<login_token>" }
   → { "access_token": "...", "device_id": "...", "user_id": "..." }
   ```

The password stays in the user's existing trusted client. The app only ever
sees the 2-minute token.

## What the app does (client-side, zero infra)

The homeserver has no rendezvous endpoint, so the app bridges the two calls
locally:

- "**Sign in with another device**" opens a small helper page in the user's
  browser (served by a localhost loopback the app spins up).
- The user pastes an **access token** from a device they're already signed in
  to (Element → `Settings → Help & About → Access Token`). The helper calls
  `get_token` **in the browser** — so the access token never reaches the app —
  and hands the resulting 2-minute `login_token` back to the loopback.
- The app redeems it (`m.login.token`) and is signed in as its own device.

Code: `apps/os/matrix.js` (`loginViaDevice` / `applyLoginToken`),
`apps/os/src/renderer/chat/`.

## Open item to verify (flagged by the homeserver admin)

`get_token` **may** trigger a UIA password re-prompt on first call per the MSC.
Quick live check needed: call step 1 with a real session token and confirm it
returns a `login_token` directly (not a `401` + UIA `flows`). The helper page
surfaces the UIA case explicitly if it happens, so we'll know — and can decide
how to handle it before unhiding the tab.

## Optional polish (the only thing that would need the admin)

The fully-seamless "scan/approve, no copy-paste" version (what Element X does)
needs a **rendezvous sidecar** on the homeserver. Not required to ship — the
flow above is complete without it. If we want the QR polish later, scope it
with the homeserver admin.
