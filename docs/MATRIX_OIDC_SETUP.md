# Enabling browser sign-in for Shape Rotator OS (homeserver side)

The OS app (`chat`/matrix tab) signs people in **without ever collecting their
password** — it opens the homeserver's SSO page in the user's real browser,
they authenticate with an identity provider (GitHub), and the homeserver
hands the app a one-time login token via a localhost callback. This is the
same pattern Element/`m.login.sso` uses.

Right now the app side is built and waiting. The homeserver
(`mtrx.shaperotator.xyz`) just needs SSO turned on. Today it advertises only:

```
$ curl https://mtrx.shaperotator.xyz/_matrix/client/v3/login
{"flows":[{"type":"m.login.password"}, {"type":"m.login.application_service"},
          {"type":"m.login.token","get_login_token":true}]}
```

We need `m.login.sso` to appear there. Two one-time steps.

## 1. Create a GitHub OAuth app

GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.

- **Homepage URL:** `https://mtrx.shaperotator.xyz`
- **Authorization callback URL:**
  `https://mtrx.shaperotator.xyz/_synapse/client/oidc/callback`

Copy the **Client ID** and generate a **Client secret**.

## 2. Synapse `homeserver.yaml`

GitHub isn't a full OIDC discovery provider, so the endpoints are explicit:

```yaml
oidc_providers:
  - idp_id: github
    idp_name: GitHub
    idp_brand: "github"
    discover: false
    issuer: "https://github.com/"
    client_id: "<GITHUB_CLIENT_ID>"
    client_secret: "<GITHUB_CLIENT_SECRET>"
    authorization_endpoint: "https://github.com/login/oauth/authorize"
    token_endpoint: "https://github.com/login/oauth/access_token"
    userinfo_endpoint: "https://api.github.com/user"
    scopes: ["read:user"]
    user_mapping_provider:
      config:
        subject_claim: "id"
        localpart_template: "{{ user.login|lower }}"
        display_name_template: "{{ user.name }}"

# Allow the desktop app's loopback callback as an SSO redirect target.
sso:
  client_whitelist:
    - "http://localhost:"
    - "http://127.0.0.1:"
```

Restart Synapse. Verify:

```
$ curl https://mtrx.shaperotator.xyz/_matrix/client/v3/login
# …now includes {"type":"m.login.sso","identity_providers":[{"id":"oidc-github","name":"GitHub",…}]}
```

The moment that flow appears, the app's matrix tab shows a **“Sign in with
GitHub”** button (no config change needed app-side — it feature-detects).

## Notes

- **Google instead of / alongside GitHub** is simpler (real OIDC discovery):
  one `oidc_providers` entry with `issuer: "https://accounts.google.com/"`,
  `client_id`/`client_secret`, `scopes: ["openid","email","profile"]`, and
  `discover: true`. The app handles any number of providers.
- The `idp_id` becomes `oidc-github` in the login flow; the app passes it
  straight through to `/_matrix/client/v3/login/sso/redirect/<idp>`.
- This is plain SSO (Synapse-managed sessions), which is the light lift. The
  fully OAuth-native path (Matrix Authentication Service / MSC3861, what
  Element X uses) is a larger deployment — a separate service Synapse
  delegates to — and isn't required for the browser sign-in UX above.
- The app's redirect target is `http://localhost:<random-port>/<nonce>`; the
  `client_whitelist` prefixes above cover it.
