import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function read(rel) {
  return readFileSync(resolve(here, rel), "utf8");
}

test("crypto outgoing requests are marked sent only after 2xx responses", () => {
  const { _test } = require("./matrix-crypto.js");
  assert.equal(_test.cryptoRequestSucceeded({ status: 200 }), true);
  assert.equal(_test.cryptoRequestSucceeded({ status: 299 }), true);

  for (const status of [0, 199, 300, 400, 401, 403, 429, 500, 503]) {
    assert.equal(_test.cryptoRequestSucceeded({ status }), false, `HTTP ${status} must stay retryable`);
  }
  assert.equal(_test.cryptoRequestSucceeded({}), false);
  assert.equal(_test.cryptoRequestSucceeded(null), false);
});

test("encrypted sends fail closed when joined member lookup is not trustworthy", () => {
  const src = read("matrix.js");
  const cryptoSrc = read("matrix-crypto.js");
  const start = src.indexOf("async function getJoinedMembers");
  const end = src.indexOf("// PUT one event into a room", start);
  assert.notEqual(start, -1, "getJoinedMembers must exist");
  assert.notEqual(end, -1, "raw send marker must exist after getJoinedMembers");

  const fn = src.slice(start, end);
  assert.match(fn, /ensureFreshTokenFor\("encrypted send"\)/);
  assert.match(fn, /if \(!res\.ok\) throw new Error/);
  assert.match(fn, /homeserver did not return joined room members/);
  assert.match(fn, /homeserver returned no joined room members/);
  assert.doesNotMatch(fn, /Object\.keys\([^)]*\.joined\s*\|\|\s*\{\}\)/);
  assert.match(cryptoSrc, /encrypted room member list is empty/);
});

test("renderer and IPC do not expose pasted access-token sign-in", () => {
  const chat = read("src/renderer/chat/chat.js");
  const preload = read("preload.js");
  const main = read("main.js");
  const matrix = read("matrix.js");

  assert.match(chat, /chat-device-login/);
  assert.match(chat, /addEventListener\("click", startDevice\)/);

  for (const [name, src] of Object.entries({ chat, preload, main, matrix })) {
    assert.doesNotMatch(src, /loginAccessToken/, `${name} must not expose loginAccessToken`);
    assert.doesNotMatch(src, /loginWithAccessToken/, `${name} must not expose loginWithAccessToken`);
    assert.doesNotMatch(src, /matrix:login-access-token/, `${name} must not expose matrix:login-access-token`);
    assert.doesNotMatch(src, /matrix:login-token/, `${name} must not expose raw access-token IPC`);
    assert.doesNotMatch(src, /async function loginToken/, `${name} must not expose raw access-token adoption`);
    assert.doesNotMatch(src, /matrix\.loginToken/, `${name} must not invoke raw access-token adoption`);
    assert.doesNotMatch(src, /chat-token-form/, `${name} must not render the old token form`);
  }
  assert.doesNotMatch(preload, /loginToken:/, "preload must not expose a raw access-token bridge");
  assert.doesNotMatch(matrix, /adopt an existing access token|token-paste/, "matrix module must not document token-paste login as supported");
  assert.match(matrix, /type: "m\.login\.token"/, "one-time login-token redemption must remain available");
});
