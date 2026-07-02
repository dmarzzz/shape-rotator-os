import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChatMarkdown } from "./chat-markdown.mjs";

test("chat-markdown: bold, italics, headings, code — the raw-stars bug", () => {
  const html = renderChatMarkdown("## What I found\n\nYour team **pivoted** to *transcripts* — see `alchemy.js`.");
  assert.match(html, /<h2>What I found<\/h2>/);
  assert.match(html, /<strong>pivoted<\/strong>/);
  assert.match(html, /<em>transcripts<\/em>/);
  assert.match(html, /<code>alchemy\.js<\/code>/);
  assert.doesNotMatch(html, /\*\*/);
});

test("chat-markdown: lists, blockquote, paragraphs with breaks", () => {
  const html = renderChatMarkdown("Here:\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\nline a\nline b");
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /<p>line a<br>line b<\/p>/);
});

test("chat-markdown: escapes HTML everywhere, even in code fences", () => {
  const html = renderChatMarkdown("<img onerror=x>\n\n```\n<script>alert(1)</script>\n```");
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre><code>/);
});

test("chat-markdown: links only for http(s); others render as plain label", () => {
  const html = renderChatMarkdown("[ok](https://example.com) and [bad](javascript:alert(1))");
  assert.match(html, /<a href="https:\/\/example\.com" data-external>ok<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /bad/);
});

test("chat-markdown: plain text passes through as a paragraph; empty stays empty", () => {
  assert.equal(renderChatMarkdown("just a sentence"), "<p>just a sentence</p>");
  assert.equal(renderChatMarkdown(""), "");
  assert.equal(renderChatMarkdown(null), "");
});

test("chat-markdown: unterminated fence still renders as code, not lost", () => {
  const html = renderChatMarkdown("```\nconst x = 1;");
  assert.match(html, /<pre><code>const x = 1;<\/code><\/pre>/);
});
