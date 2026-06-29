import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("apps/os/src/renderer/asks.js");
const source = fs.readFileSync(sourcePath, "utf8");
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const {
  askDisplayVerb,
  askExpiresLabel,
  askHasJoined,
  askIntent,
  askIntentLabel,
  askIsOpen,
  asksWithStatus,
} = mod;

const NOW = Date.UTC(2026, 5, 28, 12);

test("ask intent defaults and aliases stay backwards compatible", () => {
  assert.equal(askIntent({}), "ask");
  assert.equal(askIntent({ intent: "activity" }), "come_join");
  assert.equal(askIntent({ intent: "announcement" }), "come_join");
  assert.equal(askIntentLabel({ intent: "come_join" }), "come join");
});

test("future come join posts stay open until their plan date passes", () => {
  const [post] = asksWithStatus([{
    record_id: "join-rock-climbing",
    record_type: "ask",
    intent: "come_join",
    posted_at: "2026-06-01",
    starts_at: "2026-06-29 18:00",
    status: "open",
  }], NOW);

  assert.equal(post._expired, false);
  assert.equal(post._startOffsetDays, 1);
  assert.equal(askIsOpen(post), true);
});

test("dated come join posts expire after the date has passed", () => {
  const [post] = asksWithStatus([{
    record_id: "old-plan",
    intent: "come_join",
    posted_at: "2026-06-27",
    starts_at: "2026-06-27",
    status: "open",
  }], NOW);

  assert.equal(post._expired, true);
  assert.equal(askIsOpen(post), false);
});

test("same-day timed come join posts expire after their start time passes", () => {
  const [post] = asksWithStatus([{
    record_id: "morning-plan",
    intent: "come_join",
    posted_at: "2026-06-28 07:00",
    starts_at: "2026-06-28 09:00",
    status: "open",
  }], NOW);

  assert.equal(post._expired, true);
  assert.equal(askIsOpen(post), false);
});

test("joined_by matches profile identity using normalized handles", () => {
  const post = {
    intent: "come_join",
    joined_by: ["https://github.com/mikeishiring", "@someoneelse"],
  };
  assert.equal(askHasJoined(post, { profileUser: { github: "mikeishiring" } }), true);
  assert.equal(askHasJoined(post, { profileUser: { github: "not-mike" } }), false);
});

test("plain text join verbs get an intent icon instead of losing the first letter", () => {
  const display = askDisplayVerb("come join", "come_join");
  assert.equal(display.label, "come join");
  assert.equal(display.glyph, "");
  assert.match(display.icon, /<svg/);
});

test("limited asks expire after expires_at even when posted recently", () => {
  const [post] = asksWithStatus([{
    record_id: "irl-help",
    intent: "ask",
    posted_at: "2026-06-27",
    starts_at: "2026-06-27 18:00",
    expires_at: "2026-06-27 20:00",
    status: "open",
  }], NOW);

  assert.equal(post._expired, true);
  assert.equal(askIsOpen(post), false);
});

test("same-day timed asks expire after the deadline time passes", () => {
  const [post] = asksWithStatus([{
    record_id: "morning-help",
    intent: "ask",
    posted_at: "2026-06-28 08:00",
    starts_at: "2026-06-28 08:30",
    expires_at: "2026-06-28 09:00",
    status: "open",
  }], NOW);

  assert.equal(post._expired, true);
  assert.equal(askIsOpen(post), false);
  assert.equal(askExpiresLabel(post, NOW), "until today 09:00");
});

test("date-only ask deadlines stay open through the named day", () => {
  const [post] = asksWithStatus([{
    record_id: "today-help",
    intent: "ask",
    posted_at: "2026-06-28",
    expires_at: "2026-06-28",
    status: "open",
  }], NOW);

  assert.equal(post._expired, false);
  assert.equal(askIsOpen(post), true);
});

test("expires_at gets a relative label for ask chips", () => {
  assert.equal(askExpiresLabel({ expires_at: "2026-06-29 20:00" }, NOW), "until tomorrow 20:00");
});
