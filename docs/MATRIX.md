# joining the cohort matrix server

> **STATUS — STUB.** This doc is a placeholder for the cohort steward
> ([@amiller](https://github.com/amiller)) to fill in once the
> homeserver, room, and registration policy are settled. Until then,
> the steps below are TODOs.

## what you'll need

- A device that can run [Element](https://element.io/download) (web,
  desktop, or mobile) or any Matrix-compatible client.
- About 5 minutes.

## steps (TODO — operator to fill)

### 1. create a Matrix account

TODO(steward): which homeserver are we using? Options:
- self-hosted at `matrix.shape-rotator.xyz` (pending)
- a public homeserver like `matrix.org` (no setup, but tied to a
  shared identity space)
- something else

Once decided, paste the homeserver URL + account creation flow here.

### 2. join the cohort room

TODO(steward): publish the room ID once the room exists.

Example shape:

```
#shape-rotator-cohort-01:matrix.shape-rotator.xyz
```

In Element, click **+** next to "Rooms" → **Join public room** →
paste the room ID → Join.

### 3. say hi

A short introduction in the room — your handle, what you're working
on, and one thing you'd be a good thought partner on. Mirrors your
cohort profile's `comm_style` + `contribute_interests` fields.

---

## related: have your local agent join too

After you're in the room as a human, you can also wire up your local
agent as a bot — it can post research summaries, ship updates, etc.
on your behalf. That's the **BONUS** step in the onboarding flow, and
it routes through the `/matrix-bot-setup` skill in
[shape-rotator-field-kit](https://github.com/dmarzzz/shape-rotator-field-kit/blob/main/skills/matrix-bot-setup/SKILL.md).

That skill is also a stub right now — it'll come online once this
doc has the homeserver + room IDs filled in.
