// chat-markdown.mjs — minimal, escape-first markdown → HTML for chat bubbles.
//
// The cohort chat streams plain text (the type-out effect), then the finished
// message is swapped to rendered markdown via renderChatMarkdown(). Kept
// deliberately smaller than alchemy.js::renderProgramMarkdown (the full
// article/program renderer with GFM tables): chat answers need headings, bold,
// lists, code, links — nothing more. Everything is HTML-escaped BEFORE inline
// rules run, so model output can never inject markup.

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(text) {
  let t = escHtml(text);
  // code spans first so emphasis rules never touch their contents
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|\s)_([^_\n]+)_/g, "$1<em>$2</em>");
  // [label](url) — external http(s) links only; anything else stays inert
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    /^https?:\/\//.test(url) ? `<a href="${url}" data-external>${label}</a>` : label);
  return t;
}

export function renderChatMarkdown(md) {
  const src = String(md || "").replace(/\r\n/g, "\n").trim();
  if (!src) return "";
  const lines = src.split("\n");
  const out = [];
  let list = null;      // "ul" | "ol" | null
  let para = [];        // pending paragraph lines
  let fence = null;     // collected fenced-code lines, or null
  const closePara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (fence !== null) {
      if (/^```/.test(line.trim())) { out.push(`<pre><code>${escHtml(fence.join("\n"))}</code></pre>`); fence = null; }
      else fence.push(raw);
      continue;
    }
    if (/^```/.test(line.trim())) { closePara(); closeList(); fence = []; continue; }
    if (!line.trim()) { closePara(); closeList(); continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      closePara(); closeList();
      const lvl = Math.min(4, h[1].length); // cap depth — bubbles are small
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    const ul = /^\s*[-*•]\s+(.+)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ul || ol) {
      closePara();
      const want = ul ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { closePara(); closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }
    if (list) closeList();
    para.push(line);
  }
  if (fence !== null) out.push(`<pre><code>${escHtml(fence.join("\n"))}</code></pre>`);
  closePara(); closeList();
  return out.join("");
}
