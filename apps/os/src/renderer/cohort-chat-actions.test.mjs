import test from "node:test";
import assert from "node:assert/strict";
import {
  PROPOSABLE_PROFILE_FIELDS, ACTION_TYPES, MAX_ACTIONS_PER_TURN,
  normalizeGithubHandle, normalizeGithubRepo, normalizeEmail, normalizeTelegram, sanitizeProfileFields,
  sanitizeAction, extractJsonChunks, parseChatActions,
} from "./cohort-chat-actions.mjs";

const known = new Set(["dmarz", "ada", "loom"]);
const selfCtx = { proposerRecordId: "dmarz", proposerClaimHash: "abc123", knownRecordIds: known };
const otherCtx = { proposerRecordId: "ada", proposerClaimHash: "def456", knownRecordIds: known };
const withTeamCtx = { ...selfCtx, knownTeamIds: new Set(["loom"]) };

// ── github normalizers ────────────────────────────────────────────────────────
test("normalizeGithubHandle strips @, URL, and rejects junk", () => {
  assert.equal(normalizeGithubHandle("@dmarz"), "dmarz");
  assert.equal(normalizeGithubHandle("https://github.com/dmarz"), "dmarz");
  assert.equal(normalizeGithubHandle("github.com/dmarz/shape-rotator-os"), "dmarz");
  assert.equal(normalizeGithubHandle("not a handle!"), "");
  assert.equal(normalizeGithubHandle("-bad"), "");
  assert.equal(normalizeGithubHandle(""), "");
});

test("normalizeGithubRepo yields owner/repo or empty", () => {
  assert.equal(normalizeGithubRepo("dmarzzz/shape-rotator-os"), "dmarzzz/shape-rotator-os");
  assert.equal(normalizeGithubRepo("https://github.com/dmarzzz/shape-rotator-os.git"), "dmarzzz/shape-rotator-os");
  assert.equal(normalizeGithubRepo("just-owner"), "");
  assert.equal(normalizeGithubRepo("a/b/c"), "");
});

test("normalizeEmail keeps safe addresses only", () => {
  assert.equal(normalizeEmail("  MailTo:ADA+demo@Example.COM "), "ada+demo@example.com");
  assert.equal(normalizeEmail("ada@example"), "");
  assert.equal(normalizeEmail("ada @example.com"), "");
  assert.equal(normalizeEmail("ada@example.com,other@example.com"), "");
});

test("normalizeTelegram keeps handle/link details only", () => {
  assert.equal(normalizeTelegram("@Ada_Builds"), "@Ada_Builds");
  assert.equal(normalizeTelegram("https://t.me/Ada_Builds"), "@Ada_Builds");
  assert.equal(normalizeTelegram("t.me/Ada_Builds"), "");
  assert.equal(normalizeTelegram("@bad"), "");
  assert.equal(normalizeTelegram("not a handle"), "");
});

// ── field whitelist ───────────────────────────────────────────────────────────
test("sanitizeProfileFields keeps only whitelisted fields and drops junk", () => {
  const out = sanitizeProfileFields({
    comm_style: "async first",
    contribute_interests: ["demo feedback"],
    now: "  building the mirror  ",
    availability_pref: "mornings",
    skills: ["ts", "", "rust", 42],
    go_to_them_for: ["local-first apps"],
    working_style: "prototype with users",
    record_id: "HACK",          // off-whitelist
    team: "cube",               // off-whitelist
    geo: "NYC",
    links: { github: "@dmarz", repo: "dmarzzz/shape-rotator-os", website: "evil.com" },
    email: "private@example.com", // private contact info belongs to submit_private_contact
    telegram: "@private_telegram", // private contact info belongs to submit_private_contact
  });
  assert.deepEqual(out, {
    comm_style: "async first",
    contribute_interests: ["demo feedback"],
    now: "building the mirror",
    availability_pref: "mornings",
    skills: ["ts", "rust", "42"],
    go_to_them_for: ["local-first apps"],
    working_style: "prototype with users",
    geo: "NYC",
    links: { github: "dmarz", repo: "dmarzzz/shape-rotator-os" }, // website dropped
  });
});

test("profile update drops private contact info instead of publishing it", () => {
  assert.deepEqual(sanitizeProfileFields({ email: "ada@example.com", telegram: "@ada_builds" }), {});
});

test("sanitizeProfileFields drops a links object with nothing valid", () => {
  assert.deepEqual(sanitizeProfileFields({ links: { website: "x.com" } }), {});
  assert.deepEqual(sanitizeProfileFields({ links: "github.com/dmarz" }), {});
});

test("skill_areas is filtered to the controlled vocab when provided", () => {
  const out = sanitizeProfileFields(
    { skill_areas: ["ml", "design", "bogus"] },
    { allowedSkillAreas: new Set(["ml", "design"]) },
  );
  assert.deepEqual(out, { skill_areas: ["ml", "design"] });
});

// ── provenance stamping ───────────────────────────────────────────────────────
test("propose_profile_update stamps is_self=true for own profile", () => {
  const a = sanitizeAction(
    { action: "propose_profile_update", subject_record_id: "dmarz", fields: { now: "x" } },
    selfCtx,
  );
  assert.equal(a.action, "propose_profile_update");
  assert.equal(a.subject_record_id, "dmarz");
  assert.deepEqual(a.delta, { now: "x" });
  assert.deepEqual(a.origin, { proposer_record_id: "dmarz", proposer_claim_hash: "abc123", is_self: true });
});

test("propose_profile_update about ANOTHER member is flagged is_self=false", () => {
  const a = sanitizeAction(
    { action: "propose_profile_update", subject_record_id: "dmarz", fields: { geo: "NYC" } },
    otherCtx, // ada proposing about dmarz
  );
  assert.equal(a.origin.proposer_record_id, "ada");
  assert.equal(a.origin.is_self, false);
});

test("a proposal with no proposable fields is dropped", () => {
  assert.equal(
    sanitizeAction({ action: "propose_profile_update", subject_record_id: "dmarz", fields: { team: "x" } }, selfCtx),
    null,
  );
});

test("a proposal about an UNKNOWN record is dropped (model can't invent people)", () => {
  assert.equal(
    sanitizeAction({ action: "propose_profile_update", subject_record_id: "ghost", fields: { now: "x" } }, selfCtx),
    null,
  );
});

// ── other verbs ───────────────────────────────────────────────────────────────
test("propose_connection requires two distinct known records", () => {
  const ok = sanitizeAction(
    { action: "propose_connection", from_record_id: "ada", to_record_id: "loom", reason: "both on RL" },
    otherCtx,
  );
  assert.equal(ok.from_record_id, "ada");
  assert.equal(ok.to_record_id, "loom");
  assert.equal(ok.origin.is_self, true); // ada proposing her own connection
  assert.equal(sanitizeAction({ action: "propose_connection", from_record_id: "ada", to_record_id: "ada" }, otherCtx), null);
  assert.equal(sanitizeAction({ action: "propose_connection", from_record_id: "ada", to_record_id: "ghost" }, otherCtx), null);
});

test("request_scan keeps only sessions/github sources", () => {
  assert.deepEqual(sanitizeAction({ action: "request_scan", sources: ["github", "email", "sessions"] }).sources, ["github", "sessions"]);
  assert.equal(sanitizeAction({ action: "request_scan", sources: ["email"] }), null);
});

test("submit_private_contact captures valid person contact details privately", () => {
  const a = sanitizeAction(
    { action: "submit_private_contact", subject_record_id: "ada", email: "Ada@Example.com", telegram: "https://t.me/AdaBuilds", display_name: "Ada", note: "from intake" },
    selfCtx,
  );
  assert.equal(a.action, "submit_private_contact");
  assert.equal(a.subject_record_id, "ada");
  assert.equal(a.email, "ada@example.com");
  assert.equal(a.telegram, "@AdaBuilds");
  assert.equal(a.display_name, "Ada");
  assert.equal(a.note, "from intake");
  assert.deepEqual(a.origin, { proposer_record_id: "dmarz", proposer_claim_hash: "abc123", is_self: false });
});

test("submit_private_contact accepts telegram without email", () => {
  const a = sanitizeAction(
    { action: "submit_private_contact", subject_record_id: "ada", telegram: "@AdaBuilds" },
    selfCtx,
  );
  assert.equal(a.email, null);
  assert.equal(a.telegram, "@AdaBuilds");
});

test("submit_private_contact drops unknown, team, or invalid-contact targets", () => {
  assert.equal(sanitizeAction({ action: "submit_private_contact", subject_record_id: "ghost", email: "g@example.com" }, selfCtx), null);
  assert.equal(sanitizeAction({ action: "submit_private_contact", subject_record_id: "loom", email: "team@example.com" }, withTeamCtx), null);
  assert.equal(sanitizeAction({ action: "submit_private_contact", subject_record_id: "ada", email: "not-email" }, selfCtx), null);
  assert.equal(sanitizeAction({ action: "submit_private_contact", subject_record_id: "ada", telegram: "not handle" }, selfCtx), null);
});

test("ask + note pass through clamped; unknown verbs are dropped", () => {
  assert.equal(sanitizeAction({ action: "ask", question: "what shipped this week?" }).question, "what shipped this week?");
  assert.equal(sanitizeAction({ action: "note", text: "looks good" }).text, "looks good");
  assert.equal(sanitizeAction({ action: "delete_everything", target: "*" }), null);
  assert.equal(sanitizeAction({ action: "eval", code: "x" }), null);
});

test("args may be nested under args/params or splatted", () => {
  const a = sanitizeAction({ type: "ask", args: { question: "hi?" } });
  assert.equal(a.question, "hi?");
});

// ── stdout parsing ────────────────────────────────────────────────────────────
test("extractJsonChunks finds balanced objects past reasoning + ANSI noise", () => {
  const raw = "Let me think... {\"not\": \"an action\"}\n```json\n{\"action\":\"note\",\"text\":\"done\"}\n```";
  const chunks = extractJsonChunks(raw);
  assert.ok(chunks.some((c) => c.includes("\"action\"")));
});

test("parseChatActions prefers the LAST batch and sanitizes each", () => {
  const raw = [
    "I'll propose two updates.",
    '{"actions":[',
    '  {"action":"propose_profile_update","subject_record_id":"dmarz","fields":{"now":"shipping the agent loop","links":{"github":"dmarz"}}},',
    '  {"action":"submit_private_contact","subject_record_id":"ada","email":"ada@example.com","telegram":"@AdaBuilds"},',
    '  {"action":"file_contest","subject_record_id":"loom","contest_kind":"stale_declaration"},',
    '  {"action":"hack","subject_record_id":"dmarz"}',
    "]}",
  ].join("\n");
  const { actions } = parseChatActions(raw, selfCtx);
  assert.equal(actions.length, 3); // the hack verb is dropped
  assert.equal(actions[0].action, "propose_profile_update");
  assert.deepEqual(actions[0].delta, { now: "shipping the agent loop", links: { github: "dmarz" } });
  assert.equal(actions[0].origin.is_self, true);
  assert.equal(actions[1].action, "submit_private_contact");
  assert.equal(actions[1].email, "ada@example.com");
  assert.equal(actions[1].telegram, "@AdaBuilds");
  assert.equal(actions[2].action, "file_contest");
});

test("parseChatActions caps at MAX_ACTIONS_PER_TURN", () => {
  const many = Array.from({ length: 10 }, (_, i) => `{"action":"note","text":"n${i}"}`);
  const raw = `{"actions":[${many.join(",")}]}`;
  const { actions } = parseChatActions(raw, selfCtx);
  assert.equal(actions.length, MAX_ACTIONS_PER_TURN);
});

test("parseChatActions returns [] on plain prose (no actions)", () => {
  assert.deepEqual(parseChatActions("Here is a friendly answer with no JSON.", selfCtx).actions, []);
});

test("contract surface is frozen + complete", () => {
  assert.ok(Object.isFrozen(PROPOSABLE_PROFILE_FIELDS));
  assert.ok(Object.isFrozen(ACTION_TYPES));
  // every advertised verb has a sanitizer (sanitizeAction returns non-null for a minimal valid shape or null, never throws)
  for (const v of ACTION_TYPES) assert.doesNotThrow(() => sanitizeAction({ action: v }, selfCtx));
});
