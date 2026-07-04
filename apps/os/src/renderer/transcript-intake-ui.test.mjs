import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVisibleTranscriptPathRows,
  normalizeVisibleTranscriptPath,
  transcriptPathBlocker,
  transcriptPathNoteText,
  transcriptSubmitLabel,
} from "./transcript-intake-ui.mjs";

test("transcript path picker shows the three human choices", () => {
  const rows = buildVisibleTranscriptPathRows([
    { key: "drive_inbox", label: "Drive inbox" },
    { key: "metadata", label: "Pointer only" },
    { key: "supabase_raw", label: "Send full text" },
    { key: "local_agent", label: "Process here" },
  ]);

  assert.deepEqual(rows.map((row) => row.key), ["metadata", "supabase_raw", "local_agent"]);
  assert.deepEqual(rows.map((row) => row.label), ["Private pointer", "Send full text", "Local readout"]);
  assert.equal(rows[0].short, "file stays private");
});

test("legacy or backend-only transcript paths normalize to private pointer", () => {
  assert.equal(normalizeVisibleTranscriptPath("drive_inbox"), "metadata");
  assert.equal(normalizeVisibleTranscriptPath("unknown"), "metadata");
  assert.match(transcriptPathNoteText("drive_inbox"), /Stages the file locally/);
});

test("full-text paths reject PDFs with plain user copy", () => {
  assert.equal(transcriptPathBlocker({
    fileName: "board deck.pdf",
    ext: ".pdf",
    processingPath: "metadata",
  }), "");

  assert.equal(transcriptPathBlocker({
    fileName: "board deck.pdf",
    ext: ".pdf",
    processingPath: "supabase_raw",
  }), "board deck.pdf is not a text transcript. Use Private pointer for PDFs and docs.");
});

test("submit labels stay action-shaped", () => {
  assert.equal(transcriptSubmitLabel("metadata", 1), "Add pointer");
  assert.equal(transcriptSubmitLabel("metadata", 3), "Add 3 pointers");
  assert.equal(transcriptSubmitLabel("supabase_raw", 2), "Send 2 files");
  assert.equal(transcriptSubmitLabel("local_agent", 2), "Run 2 readouts");
});
