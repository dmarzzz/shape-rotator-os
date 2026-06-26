import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, normalizeRepo, memberTeams, matchTeamText, focusForTeam, resolveChatFocus,
} from "./cohort-chat-focus.mjs";

const surface = {
  people: [
    { record_id: "lsdan", name: "LSDan", team: "teesql", secondary_teams: ["abra"],
      links: { github: "lsdan", repo: "lsdan/dotfiles" } },
    { record_id: "nobody", name: "No Team" },
  ],
  teams: [
    { record_id: "teesql", name: "TeeSQL", links: { repo: "lsdan/teesql", github: "tee-sql" },
      skill_areas: ["tee", "confidential-db"] },
    { record_id: "abra", name: "Abra", links: { repo: "https://github.com/abra-org/abra.git" } },
    { record_id: "other", name: "Unrelated" },
  ],
};
const me = { record_id: "lsdan" };

test("normalizeRepo accepts owner/repo and full urls, rejects bare handles/paths", () => {
  assert.equal(normalizeRepo("lsdan/teesql"), "lsdan/teesql");
  assert.equal(normalizeRepo("https://github.com/abra-org/abra.git"), "abra-org/abra");
  assert.equal(normalizeRepo("LSDan/TeeSQL"), "lsdan/teesql"); // lowercased
  assert.equal(normalizeRepo("lsdan"), ""); // a handle is not a repo
  assert.equal(normalizeRepo(""), "");
});

test("tokenize drops cohort-ubiquitous filler", () => {
  const t = tokenize("I'm working on the TeeSQL project");
  assert.ok(t.includes("teesql"));
  assert.ok(!t.includes("working"));
  assert.ok(!t.includes("the"));
});

test("memberTeams returns primary then secondary, resolved + de-duped", () => {
  const teams = memberTeams(surface, me);
  assert.deepEqual(teams.map((t) => t.record_id), ["teesql", "abra"]);
  assert.deepEqual(memberTeams(surface, { record_id: "nobody" }), []);
});

test("matchTeamText finds the team the member named", () => {
  const teams = memberTeams(surface, me);
  assert.equal(matchTeamText("let's refresh teesql", teams)?.record_id, "teesql");
  assert.equal(matchTeamText("update Abra please", teams)?.record_id, "abra");
  assert.equal(matchTeamText("nothing relevant here", teams), null);
});

test("focusForTeam scopes repos to the project (+ member's own repo, handle is not a repo)", () => {
  const teams = memberTeams(surface, me);
  const person = surface.people[0];
  const f = focusForTeam(teams[0], { person });
  assert.equal(f.teamId, "teesql");
  assert.equal(f.teamName, "TeeSQL");
  assert.deepEqual(f.repos, ["lsdan/teesql", "lsdan/dotfiles"]); // team repo + member's repo; the github handle "tee-sql" is not a repo
});

test("resolveFocus: explicit pick beats named beats primary", () => {
  assert.equal(resolveChatFocus({ surface, identity: me, selectedTeamId: "abra" }).focus.teamId, "abra");
  assert.equal(resolveChatFocus({ surface, identity: me, mentioned: "working on abra" }).focus.teamId, "abra");
  const def = resolveChatFocus({ surface, identity: me });
  assert.equal(def.focus.teamId, "teesql");
  assert.equal(def.reason, "default-primary"); // >1 team ⇒ caller should let them confirm/switch
  assert.equal(def.candidates.length, 2);
});

test("resolveFocus: a selection outside the member's teams is ignored (can't scope to a foreign project)", () => {
  const r = resolveChatFocus({ surface, identity: me, selectedTeamId: "other" });
  assert.equal(r.focus.teamId, "teesql"); // falls back to their own primary, not "other"
});

test("resolveFocus: no team ⇒ null focus (caller falls back to unscoped + asks)", () => {
  const r = resolveChatFocus({ surface, identity: { record_id: "nobody" } });
  assert.equal(r.focus, null);
  assert.equal(r.reason, "no-team");
});
