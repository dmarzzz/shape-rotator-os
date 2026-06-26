// cohort-chat-stream.mjs — turn the local CLI's stdout into LIVE display text.
//
// Claude Code's `claude -p` BUFFERS (the whole answer lands in one chunk at the
// end — a long dead wait). With `--output-format stream-json --include-partial-
// messages --verbose` it instead emits NDJSON events, including incremental
// `content_block_delta` text deltas — so we can type the answer out as it's
// written. This accumulator parses that NDJSON, and gracefully falls back to PLAIN
// text for codex / custom commands that don't speak stream-json. Pure + node-tested.
//
// `display()` is the visible prose (the trailing {"actions":…} block the agent
// emits is hidden while typing); `finalText()` is the authoritative full text
// (incl. the action block) that cohort-chat-actions.parseChatActions consumes.

// Cut the structured-action block (complete OR mid-stream) out of the visible text.
const ACTION_CUT = /```json\s*\{?\s*"?actions|\{\s*"actions"\s*:/i;
export function visibleText(t) {
  const s = String(t == null ? "" : t);
  const m = s.search(ACTION_CUT);
  return m >= 0 ? s.slice(0, m) : s;
}

export function createChatStream() {
  let lineBuf = "";
  let text = "";          // assistant text (from text deltas, or plain lines)
  let thinking = "";      // assistant thinking (for a subtle "thinking…" cue)
  let resultText = null;  // authoritative final text from the stream-json `result`
  let sawJson = false;
  let sawPlain = false;
  let phase = "thinking"; // thinking → writing → done

  function onEvent(ev) {
    sawJson = true;
    if (ev.type === "stream_event" && ev.event && ev.event.type === "content_block_delta" && ev.event.delta) {
      const d = ev.event.delta;
      if (d.type === "text_delta" && typeof d.text === "string") { text += d.text; if (text.trim()) phase = "writing"; }
      else if (d.type === "thinking_delta" && typeof d.thinking === "string") { thinking += d.thinking; }
    } else if (ev.type === "result" && typeof ev.result === "string") {
      resultText = ev.result;
      phase = "done";
    }
  }

  return {
    push(chunk) {
      lineBuf += String(chunk == null ? "" : chunk);
      let i;
      while ((i = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1);
        const tr = line.trim();
        if (!tr) continue;
        let ev = null;
        if (tr[0] === "{") { try { const v = JSON.parse(tr); if (v && typeof v.type === "string") ev = v; } catch {} }
        if (ev) onEvent(ev);
        else { sawPlain = true; text += line + "\n"; if (text.trim()) phase = "writing"; } // plain CLI line
      }
    },
    // Visible prose so far (action block hidden). Include the partial last line so
    // plain-text typing feels live — but NOT when it's a half-arrived JSON event
    // (it'd flash raw `{"type":…` into the bubble).
    display() {
      let raw = text;
      if (!sawJson && !lineBuf.trimStart().startsWith("{")) raw += lineBuf;
      return visibleText(raw).replace(/\s+$/, "");
    },
    // The full assistant text (incl. the action block) for parsing — prefer the
    // stream-json `result` (authoritative) over concatenated deltas.
    finalText() {
      if (resultText != null && resultText.trim()) return resultText.trim();
      return (sawJson ? text : text + lineBuf).trim();
    },
    phase() { return phase; },
    thinking() { return thinking.trim(); },
  };
}
