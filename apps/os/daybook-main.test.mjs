import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("router voice transcription helpers have hard timeouts", () => {
  const source = fs.readFileSync(path.join(here, "daybook-main.js"), "utf8");

  assert.match(source, /const FFMPEG_TIMEOUT_MS/);
  assert.match(source, /const WHISPER_READY_TIMEOUT_MS/);
  assert.match(source, /const WHISPER_TRANSCRIBE_TIMEOUT_MS/);
  assert.match(source, /proc\.kill\('SIGKILL'\)/);
  assert.match(source, /setTimeout\(\(\) => finish\(''\), WHISPER_TRANSCRIBE_TIMEOUT_MS\)/);
  assert.match(source, /function runBin\(cmd, args, \{ timeoutMs = FFMPEG_TIMEOUT_MS \} = \{\}\)/);
  assert.match(source, /timed out after \$\{timeoutMs\}ms/);
});

test("router host keeps microphone permission and link days narrow", () => {
  const source = fs.readFileSync(path.join(here, "daybook-main.js"), "utf8");

  assert.match(source, /mediaType === 'audio'/);
  assert.doesNotMatch(source, /cb\(permission === 'media'\);/);
  assert.match(source, /link\.peerGetRecent\(link\.normalizeDays\(days, \{ fallback: 30, max: link\.MAX_RECENT_DAYS \}\)\)/);
  assert.match(source, /link\.peerGetRaw\(link\.normalizeDays\(days, \{ fallback: 7, max: link\.MAX_RAW_DAYS \}\)\)/);
  assert.match(source, /link\.sshGetRecent\(link\.normalizeDays\(days, \{ fallback: 30, max: link\.MAX_RECENT_DAYS \}\)\)/);
  assert.match(source, /link\.sshGetRaw\(link\.normalizeDays\(days, \{ fallback: 7, max: link\.MAX_RAW_DAYS \}\)\)/);
});
