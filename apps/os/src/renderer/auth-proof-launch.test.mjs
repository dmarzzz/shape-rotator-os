import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const osRoot = path.resolve(here, "../../");

test("transcript auth proof launcher enables the Google gate before boot mounts auth UI", () => {
  const main = fs.readFileSync(path.join(osRoot, "main.js"), "utf8");
  const boot = fs.readFileSync(path.join(osRoot, "src/renderer/boot.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(osRoot, "package.json"), "utf8"));

  assert.match(main, /--transcript-auth-proof/);
  assert.match(main, /SROS_TRANSCRIPT_AUTH_PROOF/);
  assert.match(main, /query\.authProof = "1"/);
  assert.match(boot, /params\.get\("authProof"\) === "1"/);
  assert.match(boot, /localStorage\.setItem\("srwk:auth_gate_enabled", "1"\)/);
  assert.equal(pkg.scripts["transcripts:receive:signin"], "electron . --transcript-auth-proof");
});

test("Google auth is pinned to the Shape OS app deep link", () => {
  const main = fs.readFileSync(path.join(osRoot, "main.js"), "utf8");

  assert.match(main, /const AUTH_REDIRECT\s*=\s*`\$\{DEEPLINK_SCHEME\}:\/\/auth-callback`/);
  assert.match(main, /redirect_to=\$\{encodeURIComponent\(AUTH_REDIRECT\)\}/);
  assert.match(main, /if \(url\.startsWith\(AUTH_REDIRECT\)\) \{ handleAuthCallback\(url\); return; \}/);
  assert.doesNotMatch(main, /ops-engine|railway\.app|localhost:5173|127\.0\.0\.1:5173/i);
});
