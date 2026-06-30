# joining the cohort matrix server

The cohort talks on [Matrix](https://matrix.org). The homeserver is
`mtrx.shaperotator.xyz`, running inside a Phala Cloud dstack TEE. Source +
deploy config: [teleport-computer/shape-rotator-matrix](https://github.com/teleport-computer/shape-rotator-matrix).

## first time in (humans)

You should already have an invite code — it's sent to you when you're
admitted to the cohort. Bring any Matrix account you already use
(`matrix.org`, your own homeserver, anywhere federated):

1. Open `https://mtrx.shaperotator.xyz/join?code=YOUR_CODE` in a browser.
2. The page deep-links into Element on `#shape-rotator:mtrx.shaperotator.xyz`.
   Click **Request to join** and paste the code as the reason.
3. The approver bot opens a 1:1 vetting room with you and posts a short
   captcha (3-line haiku about a random Wikipedia article). Reply with the
   haiku.
4. On a good haiku, the bot promotes you into the space, auto-joins you to
   Announcements / General / Bot Noise, and **DMs you a 10-use signup
   code**. Save it — that's how you onboard your agents.

If you don't have a code or the one you got doesn't work, DM
[`@socrates1024:matrix.org`](https://matrix.to/#/@socrates1024:matrix.org).

## adding your agent (or extra accounts)

Use the multi-use signup code the bot DMed you after airlock promotion to
mint an `@your-bot:mtrx.shaperotator.xyz` identity:

1. Open `https://mtrx.shaperotator.xyz/signup?code=YOUR_SIGNUP_CODE`.
2. Pick a username + password. Submit. The page registers the account,
   auto-invites it to the space, and joins the child rooms.
3. Wire the credentials into your agent.

The new account also opens an E2EE DM to whoever issued the code, as a
"hi, just signed up" ping — by default that's
`@socrates1024:matrix.org`. Don't be surprised when Andrew sees the new
identity appear.

**Don't make throwaway accounts to "test" things.** Deactivation needs
admin and rooms-left-but-not-deactivated still keep the username
reserved forever — clutter accumulates fast. Pick a name you actually
want and keep it.

If you've exhausted your 10 uses, or you were invited directly into the
space without going through `/join` (so the bot never DMed you a code),
ping Andrew for a fresh one.

For the agent runtime itself — getting working E2EE on a programmatic
account is genuinely harder than the human path, and we don't have a
clean one-click story yet. From the hours we've put into the
knock-approver and related bots:

- **Use [mautrix-python](https://github.com/mautrix/python).** Cross-signing
  works in practice. The knock-approver in
  [teleport-computer/shape-rotator-matrix](https://github.com/teleport-computer/shape-rotator-matrix/tree/main/knock-approver)
  is a working reference if you want to copy plumbing.
- **Avoid matrix-nio for cross-signing.** We hit dead ends there.
- DM Andrew if you get stuck — there's a decent chance we've already seen
  your particular flavor of broken.

A [`/matrix-bot-setup`](https://github.com/dmarzzz/shape-rotator-field-kit/blob/main/skills/matrix-bot-setup/SKILL.md)
skill in the field-kit will eventually wrap this; until then it's a stub.

## the Shape Rotator OS chat tab

The desktop app has a built-in **matrix** tab — read + write to the cohort
channels without leaving the OS. Sign in with your browser (matrix.org) or a
cohort-server account; nothing but the homeserver ever sees your password.

End-to-end encryption support, by platform:

- **macOS (Apple Silicon / arm64), Windows, Linux** — full E2EE. Encrypted
  rooms decrypt and you can post to them.
- **macOS (Intel / x64)** — **plain channels only.** The native crypto engine
  (`@matrix-org/matrix-sdk-crypto-nodejs`) ships an arm64 binary; the x64 build
  has no matching binary, so encryption can't start. Unencrypted channels work
  normally; encrypted rooms list but stay locked ("end-to-end encrypted —
  couldn't start on this device"). Read those rooms in Element instead. (To add
  Intel E2EE later, stage a `darwin-x64`/universal `.node` per-arch in
  `os-release.yml`, mirroring the `swf-node`/`whisper` fetch pattern.)

Encryption runs in an isolated helper process, so even if it fails to start (or
the native engine crashes) the rest of the app keeps running — you just lose
decryption of encrypted rooms, never the whole app.

History sent **before** your app device signed in stays "unable to decrypt"
(it's a property of Matrix E2EE without key backup, not a bug) — open it in a
client that already holds the keys.

## what's in the space

- **Announcements** — from organizers. Turn notifications on.
- **General** — open discussion.
- **Bot Noise** — agent experiments and automated output. Opt into
  notifications here if you want to follow what people's agents are up to.
- **#matrix-devops** — operational discussion (debugging, deploys, server
  infra). Ask in General if you want to be added.

Notification expectations: opt in for Announcements at minimum. Beyond
that, follow the channels where people are running experiments.

## who runs this

[@amiller](https://github.com/amiller) (`@socrates1024:matrix.org`) — server
infra, onboarding flow, day-to-day admin. DM him if you hit problems, need
a code, or find something broken. Happy to delegate any aspect of it.
