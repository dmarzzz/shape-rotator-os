import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOtterSlidesManifest, classifyFile } = require("./prepare-otter-slides-manifest.js");

test("Otter export scanner builds a slide manifest without raw contents or absolute paths", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shape-otter-export-"));
  try {
    fs.writeFileSync(path.join(dir, "Transcript.txt"), "sensitive raw transcript text");
    fs.writeFileSync(path.join(dir, "Summary.txt"), "private summary text");
    fs.mkdirSync(path.join(dir, "slides"));
    fs.writeFileSync(path.join(dir, "slides", "slide-10.png"), "ten");
    fs.writeFileSync(path.join(dir, "slides", "slide-2.png"), "two");
    fs.writeFileSync(path.join(dir, "slides", "slide-1.png"), "one");

    const manifest = buildOtterSlidesManifest({
      dir,
      conversationId: "Demo Presentation 123",
      title: "Private demo",
      exportedAt: "2026-06-12T12:00:00Z",
    });

    assert.equal(manifest.provider, "otter");
    assert.equal(manifest.conversation_id, "demo-presentation-123");
    assert.equal(manifest.title, "Private demo");
    assert.equal(manifest.exported_at, "2026-06-12T12:00:00Z");
    assert.equal(manifest.artifacts.length, 5);
    assert.deepEqual(
      manifest.artifacts.filter((artifact) => artifact.kind === "slides").map((artifact) => artifact.file),
      ["slides/slide-1.png", "slides/slide-2.png", "slides/slide-10.png"],
    );
    assert.deepEqual(
      manifest.artifacts.filter((artifact) => artifact.kind === "slides").map((artifact) => artifact.slide_number),
      [1, 2, 3],
    );
    assert.ok(manifest.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.source_hash)));
    assert.ok(manifest.artifacts.every((artifact) => artifact.storage_ref.startsWith("otter-export://demo-presentation-123/")));
    const json = JSON.stringify(manifest);
    assert.doesNotMatch(json, /sensitive raw transcript text/);
    assert.doesNotMatch(json, /private summary text/);
    assert.doesNotMatch(json, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Otter export scanner classifies transcripts, summaries, and slide images", () => {
  assert.equal(classifyFile("Call Transcript.txt"), "transcript");
  assert.equal(classifyFile("Meeting Summary.md"), "summary");
  assert.equal(classifyFile("screens/slide-001.jpeg"), "slides");
  assert.equal(classifyFile("audio.m4a"), "recording");
  assert.equal(classifyFile("unknown.csv"), null);
});
