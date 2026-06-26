import test from "node:test";
import assert from "node:assert/strict";
import { createChatStream, visibleText } from "./cohort-chat-stream.mjs";

// One claude --output-format stream-json text delta, as an NDJSON line.
const delta = (t) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } }) + "\n";
const thinkingDelta = (t) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } } }) + "\n";

test("visibleText hides a complete or mid-stream action block", () => {
  assert.equal(visibleText("Talk to Ada about RL.\n```json\n{\"actions\":[]}\n```"), "Talk to Ada about RL.\n");
  assert.equal(visibleText("Here you go.\n{\"actions\": [{"), "Here you go.\n"); // mid-stream
  assert.equal(visibleText("no block here"), "no block here");
});

test("stream-json: text deltas accumulate into live display + final text", () => {
  const s = createChatStream();
  s.push(JSON.stringify({ type: "system", subtype: "init" }) + "\n");
  s.push(thinkingDelta("let me check the cohort..."));
  assert.equal(s.phase(), "thinking");
  s.push(delta("Talk to "));
  s.push(delta("LSDan"));
  assert.equal(s.display(), "Talk to LSDan");
  assert.equal(s.phase(), "writing");
  s.push(delta(" about TEEs."));
  assert.equal(s.finalText(), "Talk to LSDan about TEEs.");
  assert.equal(s.thinking(), "let me check the cohort...");
});

test("stream-json: the action block is hidden from display but kept in finalText", () => {
  const s = createChatStream();
  s.push(delta("Suggesting a connection.\n"));
  s.push(delta("```json\n{\"actions\":[{\"action\":\"propose_connection\"}]}\n```"));
  assert.equal(s.display(), "Suggesting a connection."); // block hidden while/after typing
  assert.match(s.finalText(), /"actions"/);             // but available to the parser
});

test("stream-json: the result event is authoritative for finalText", () => {
  const s = createChatStream();
  s.push(delta("partial..."));
  s.push(JSON.stringify({ type: "result", subtype: "success", result: "The complete grounded answer." }) + "\n");
  assert.equal(s.finalText(), "The complete grounded answer.");
  assert.equal(s.phase(), "done");
});

test("partial NDJSON lines aren't parsed until the newline arrives", () => {
  const s = createChatStream();
  s.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_de');
  assert.equal(s.display(), ""); // incomplete JSON line not shown as garbage
  s.push('lta","text":"hi"}}}\n');
  assert.equal(s.display(), "hi");
});

test("plain text (codex / custom) streams through, partial line included", () => {
  const s = createChatStream();
  s.push("The ocean is ");          // no newline yet
  assert.equal(s.display(), "The ocean is"); // partial shown (trailing ws trimmed)
  s.push("vast.\nIt is blue.");
  assert.equal(s.finalText(), "The ocean is vast.\nIt is blue.");
});
