// markdown.mjs — a tiny, XSS-safe markdown renderer for the answer area.
//
// The model's find/engage replies are rich markdown (## headings, **bold**
// names, `- ` bullets, `code`). We render them to real DOM with createElement +
// textContent ONLY — never innerHTML of model/cohort output — so untrusted
// profile text that flows through the answer can never become live markup.
//
// Split for testability: parseBlocks + tokenizeInline are PURE (no DOM,
// unit-tested); renderMarkdownInto is the thin DOM builder (verified in-window).

// Group lines into block descriptors: { type:'heading', level, text } |
// { type:'list', items:[...] } | { type:'para', text }.
export function parseBlocks(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: "para", text: para.join(" ") }); para = []; } };
  const flushList = () => { if (list) { blocks.push({ type: "list", items: list }); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); blocks.push({ type: "heading", level: h[1].length, text: h[2] }); continue; }
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (li) { flushPara(); (list || (list = [])).push(li[1]); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return blocks;
}

// Tokenize inline **bold** and `code`; everything else is text. Unmatched
// markers stay literal (no mangling of stray * or `).
export function tokenizeInline(text) {
  const s = String(text || "");
  const tokens = [];
  let buf = "", i = 0;
  const pushText = () => { if (buf) { tokens.push({ type: "text", value: buf }); buf = ""; } };
  while (i < s.length) {
    if (s[i] === "*" && s[i + 1] === "*") {
      const end = s.indexOf("**", i + 2);
      if (end > i + 1) { pushText(); tokens.push({ type: "strong", value: s.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) { pushText(); tokens.push({ type: "code", value: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    buf += s[i]; i++;
  }
  pushText();
  return tokens;
}

function appendInline(parent, text) {
  for (const t of tokenizeInline(text)) {
    if (t.type === "strong") { const e = document.createElement("strong"); e.textContent = t.value; parent.appendChild(e); }
    else if (t.type === "code") { const e = document.createElement("code"); e.textContent = t.value; parent.appendChild(e); }
    else parent.appendChild(document.createTextNode(t.value));
  }
}

// Clear `el` and render `text` as markdown DOM. Safe: all leaf text is set via
// textContent / createTextNode.
export function renderMarkdownInto(el, text) {
  el.textContent = "";
  const frag = document.createDocumentFragment();
  for (const b of parseBlocks(text)) {
    if (b.type === "heading") {
      const h = document.createElement(b.level <= 2 ? "h3" : "h4");
      appendInline(h, b.text);
      frag.appendChild(h);
    } else if (b.type === "list") {
      const ul = document.createElement("ul");
      for (const item of b.items) {
        const li = document.createElement("li");
        appendInline(li, item);
        ul.appendChild(li);
      }
      frag.appendChild(ul);
    } else {
      const p = document.createElement("p");
      appendInline(p, b.text);
      frag.appendChild(p);
    }
  }
  el.appendChild(frag);
}
