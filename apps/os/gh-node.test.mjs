import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { scanPrivateGithub, ghStatus, parseGhEvents } = require("./gh-node.js");

// A fake `gh` runner: maps a joined-args key → { status, stdout }.
function fakeRunner(map) {
  return (_bin, args) => {
    const key = args.join(" ");
    for (const [pat, res] of Object.entries(map)) {
      if (key.startsWith(pat)) return { status: 0, stdout: "", stderr: "", ...res };
    }
    return { status: 1, stdout: "", stderr: "no match" };
  };
}

test("parseGhEvents tolerates empty / non-JSON / arrays", () => {
  assert.deepEqual(parseGhEvents(""), []);
  assert.deepEqual(parseGhEvents("not json"), []);
  assert.deepEqual(parseGhEvents('[{"type":"PushEvent"}]'), [{ type: "PushEvent" }]);
  assert.deepEqual(parseGhEvents('{"not":"array"}'), []);
});

test("ghStatus reports installed + authed from gh probes", () => {
  const ok = ghStatus({ runner: fakeRunner({ "--version": {}, "auth status": {} }) });
  assert.deepEqual(ok, { installed: true, authed: true });
  const noTool = ghStatus({ runner: () => ({ status: 127, error: new Error("ENOENT") }) });
  assert.equal(noTool.installed, false);
  const unauthed = ghStatus({ runner: fakeRunner({ "--version": {}, "auth status": { status: 1 } }) });
  assert.deepEqual(unauthed, { installed: true, authed: false });
});

test("scanPrivateGithub resolves login then fetches that user's events (incl. private)", () => {
  const events = [{ type: "PushEvent", repo: { name: "lsdan/secret-repo" }, payload: { commits: [{ message: "wip" }] } }];
  const r = scanPrivateGithub({
    runner: fakeRunner({
      "--version": {}, "auth status": {},
      "api user --jq .login": { stdout: "lsdan\n" },
      "api users/lsdan/events": { stdout: JSON.stringify(events) },
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.login, "lsdan");
  assert.equal(r.events[0].repo.name, "lsdan/secret-repo");
});

test("scanPrivateGithub fails closed when gh is missing or unauthed", () => {
  assert.equal(scanPrivateGithub({ runner: () => ({ status: 127, error: new Error("x") }) }).reason, "gh_not_installed");
  assert.equal(scanPrivateGithub({ runner: fakeRunner({ "--version": {}, "auth status": { status: 1 } }) }).reason, "gh_not_authed");
});

test("scanPrivateGithub surfaces an api failure rather than pretending success", () => {
  const r = scanPrivateGithub({
    runner: fakeRunner({
      "--version": {}, "auth status": {},
      "api user --jq .login": { stdout: "lsdan" },
      "api users/lsdan/events": { status: 1, stderr: "HTTP 403" },
    }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "gh_api_failed");
});
