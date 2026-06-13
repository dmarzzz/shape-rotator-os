const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadEnvFile,
  parseEnvFile,
} = require("./lib/env-file.cjs");

test("env file parser handles comments, quotes, and export prefixes", () => {
  assert.deepEqual(parseEnvFile([
    "# comment",
    "GOOGLE_CALENDAR_ID=calendar@example.com",
    "export GOOGLE_OAUTH_CLIENT_ID=\"client-id\"",
    "GOOGLE_CALENDAR_EDITOR_EMAILS='a@example.com,b@example.com'",
    "SUPABASE_URL=https://example.supabase.co # local note",
    "",
  ].join("\n")), {
    GOOGLE_CALENDAR_ID: "calendar@example.com",
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_CALENDAR_EDITOR_EMAILS: "a@example.com,b@example.com",
    SUPABASE_URL: "https://example.supabase.co",
  });
});

test("env file loader fills missing values without overriding existing env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-env-file-"));
  const file = path.join(dir, ".env.calendar.local");
  fs.writeFileSync(file, [
    "GOOGLE_CALENDAR_ACCESS_TOKEN=from-file",
    "GOOGLE_ACCESS_TOKEN=file-fallback",
  ].join("\n"));
  const env = {
    GOOGLE_CALENDAR_ACCESS_TOKEN: "from-process",
  };

  const loaded = loadEnvFile(file, { env });

  assert.equal(loaded.GOOGLE_CALENDAR_ACCESS_TOKEN, "from-file");
  assert.equal(env.GOOGLE_CALENDAR_ACCESS_TOKEN, "from-process");
  assert.equal(env.GOOGLE_ACCESS_TOKEN, "file-fallback");
});

test("env file loader can intentionally override env values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr-env-file-"));
  const file = path.join(dir, ".env.calendar.local");
  fs.writeFileSync(file, "GOOGLE_CALENDAR_ACCESS_TOKEN=from-file\n");
  const env = {
    GOOGLE_CALENDAR_ACCESS_TOKEN: "from-process",
  };

  loadEnvFile(file, { env, override: true });

  assert.equal(env.GOOGLE_CALENDAR_ACCESS_TOKEN, "from-file");
});
