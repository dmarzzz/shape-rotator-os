import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, "../index.html");
const chatPath = resolve(here, "cohort-chat.js");

test("chat empty state exposes direct first-session routes", async () => {
  const html = await readFile(indexPath, "utf8");
  assert.match(html, /data-cc-first-action="transcript"/);
  assert.match(html, /data-cc-first-action="sync"/);
  assert.match(html, />add transcript</);
  assert.match(html, />sync profile</);
});

test("first-session routes reuse transcript and sync panes", async () => {
  const js = await readFile(chatPath, "utf8");
  assert.match(js, /\[data-cc-first-action\]/);
  assert.match(js, /setChatView\("transcript"\)/);
  assert.match(js, /renderTranscriptUploadCard\(\)/);
  assert.match(js, /setChatView\("sync"\)/);
  assert.match(js, /mountSelfReportPane\(syncPane,\s*"sync",\s*\{\s*autoRunPrevious:\s*true\s*\}\)/);
});
