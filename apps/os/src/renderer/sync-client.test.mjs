import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("apps/os/src/renderer/sync-client.js");
const source = fs.readFileSync(sourcePath, "utf8");

async function loadSyncClient() {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`);
}

test("setBaseUrl strips trailing slash, query, and hash from http overrides", async () => {
  const client = await loadSyncClient();

  client.setBaseUrl("http://localhost:7777/?debug=1#frag");
  assert.equal(client.getBaseUrl(), "http://localhost:7777");

  client.setBaseUrl("https://example.test/swf///");
  assert.equal(client.getBaseUrl(), "https://example.test/swf");
});

test("setBaseUrl ignores malformed or non-http overrides", async () => {
  const client = await loadSyncClient();

  assert.equal(client.getBaseUrl(), "http://127.0.0.1:7777");
  client.setBaseUrl("file:///tmp/socket");
  assert.equal(client.getBaseUrl(), "http://127.0.0.1:7777");
  client.setBaseUrl("not a url");
  assert.equal(client.getBaseUrl(), "http://127.0.0.1:7777");
});
