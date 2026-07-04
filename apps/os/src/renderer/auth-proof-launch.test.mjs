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
  assert.equal(pkg.scripts["transcripts:drive:consent"], "electron . --transcript-drive-auth-consent");
  assert.equal(pkg.scripts["transcripts:drive:auth-smoke"], "electron . --transcript-drive-auth-smoke");
  assert.equal(pkg.scripts["transcripts:drive:intake-smoke"], "electron . --transcript-drive-intake-smoke");
});

test("Google auth is pinned to the Shape OS app deep link", () => {
  const main = fs.readFileSync(path.join(osRoot, "main.js"), "utf8");

  assert.match(main, /const AUTH_REDIRECT\s*=\s*`\$\{DEEPLINK_SCHEME\}:\/\/auth-callback`/);
  assert.match(main, /url\.searchParams\.set\("redirect_to", AUTH_REDIRECT\)/);
  assert.match(main, /if \(url\.startsWith\(AUTH_REDIRECT\)\) \{ handleAuthCallback\(url\); return; \}/);
  assert.doesNotMatch(main, /localhost:5173|127\.0\.0\.1:5173/i);
});

test("Google auth asks for narrow Drive upload scope without exposing provider tokens to the renderer", () => {
  const main = fs.readFileSync(path.join(osRoot, "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(osRoot, "preload.js"), "utf8");
  const chat = fs.readFileSync(path.join(osRoot, "src/renderer/cohort-chat.js"), "utf8");

  assert.match(main, /const GOOGLE_DRIVE_FILE_SCOPE = "https:\/\/www\.googleapis\.com\/auth\/drive\.file"/);
  assert.match(main, /url\.searchParams\.set\("scopes", googleAuthScopes\(\)\.join\(" "\)\)/);
  assert.match(main, /provider_token: j\.provider_token/);
  assert.match(main, /function publicAuthSession/);
  assert.match(main, /provider_token_available: !!provider_token/);
  assert.match(main, /function clearAuthProviderTokens/);
  assert.match(main, /reason: "drive_upload_unauthorized"/);
  assert.doesNotMatch(main, /session\.provider_token = cur\.provider_token/);
  assert.match(main, /if \(authSession\?\.provider_token\) driveConfig\.accessToken = authSession\.provider_token/);
  assert.match(main, /function runTranscriptDriveAuthSmoke/);
  assert.match(main, /function runTranscriptDriveIntakeSmoke/);
  assert.match(main, /function resolveTranscriptArtifactOrgId/);
  assert.match(main, /liveUploadAttempted/);
  assert.match(main, /liveIntakeAttempted/);
  assert.match(main, /org_memberships/);
  assert.match(main, /supabaseConfig\.orgId = resolvedOrg\.orgId/);
  assert.match(main, /SROS_TRANSCRIPT_DRIVE_INTAKE_BULK/);
  assert.match(main, /SROS_TRANSCRIPT_INTAKE_SMOKE_SESSION_ID/);
  assert.doesNotMatch(preload, /provider_token/);
  assert.doesNotMatch(chat, /data-cc-transcript-drive-token|driveAccessToken|googleDriveAccessToken/);
  assert.match(chat, /data-cc-transcript-drive-reconnect/);
});
