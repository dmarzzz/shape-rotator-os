// hermes-markdown.test.mjs — the pure parsers behind the answer renderer.
// (The DOM builder is verified in-window; here we lock parsing + the safety
// property that HTML/markup is treated as literal text, never structure.)
import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, tokenizeInline } from "./markdown.mjs";

test("parseBlocks: headings, bullets, paragraphs", () => {
  const b = parseBlocks("## People\n\n**Ron** — SignalStack\n- Go to them for: X\n- Opener: Y\n\nplain para");
  assert.equal(b[0].type, "heading");
  assert.equal(b[0].level, 2);
  assert.equal(b[0].text, "People");
  assert.equal(b[1].type, "para");
  assert.match(b[1].text, /\*\*Ron\*\*/);
  assert.equal(b[2].type, "list");
  assert.equal(b[2].items.length, 2);
  assert.equal(b[3].type, "para");
  assert.equal(b[3].text, "plain para");
});

test("tokenizeInline: bold + code + plain text, unmatched markers stay literal", () => {
  assert.deepEqual(tokenizeInline("go to **Ron** for `dstack` now"), [
    { type: "text", value: "go to " },
    { type: "strong", value: "Ron" },
    { type: "text", value: " for " },
    { type: "code", value: "dstack" },
    { type: "text", value: " now" },
  ]);
  assert.deepEqual(tokenizeInline("a * b ` c"), [{ type: "text", value: "a * b ` c" }]);
});

test("safety: markup is tokenized as literal text, never structure", () => {
  // The renderer sets these via textContent, so even this stays inert; the
  // tokenizer must not split it into anything but a single text token.
  const t = tokenizeInline("<img src=x onerror=alert(1)>");
  assert.equal(t.length, 1);
  assert.equal(t[0].type, "text");
  assert.equal(t[0].value, "<img src=x onerror=alert(1)>");
});
