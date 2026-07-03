const cards = Array.from(document.querySelectorAll(".links-list .link-card"));
const preview = {
  kicker: document.querySelector("[data-preview-kicker]"),
  title: document.querySelector("[data-preview-title]"),
  desc: document.querySelector("[data-preview-desc]"),
  frameShell: document.querySelector("[data-preview-frame-shell]"),
  frame: document.querySelector("[data-preview-frame]"),
  links: document.querySelector("[data-preview-links]"),
  note: document.querySelector("[data-preview-note]"),
  primary: document.querySelector("[data-preview-primary]"),
  url: document.querySelector("[data-preview-url]"),
  behavior: document.querySelector("[data-preview-behavior]"),
};
const embeddedCache = new Map();
let previewRequestId = 0;
const URL_TEXT_RE = /\b((?:https?:\/\/)?(?:github\.com|shaperotator\.xyz|mtrx\.shaperotator\.xyz|onboard\.shaperotator\.xyz|school\.shaperotator\.xyz)\/[^\s<]*)/gi;

function text(card, selector) {
  return card.querySelector(selector)?.textContent?.trim() || "";
}

function sameOriginPath(url) {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.origin === location.origin) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return parsed.hostname.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function linkifyBareUrls(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!URL_TEXT_RE.test(node.nodeValue || "")) return NodeFilter.FILTER_REJECT;
      URL_TEXT_RE.lastIndex = 0;
      if (node.parentElement?.closest("a, script, style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach((node) => {
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const match of node.nodeValue.matchAll(URL_TEXT_RE)) {
      const raw = match[1];
      frag.append(node.nodeValue.slice(last, match.index));
      const a = doc.createElement("a");
      a.href = raw.startsWith("http") ? raw : `https://${raw}`;
      a.textContent = raw;
      frag.append(a);
      last = match.index + raw.length;
    }
    frag.append(node.nodeValue.slice(last));
    node.replaceWith(frag);
  });
}

async function embeddedHtml(url) {
  if (embeddedCache.has(url)) return embeddedCache.get(url);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`preview fetch failed: ${response.status}`);

  const html = await response.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.createElement("base");
  base.href = url;
  doc.head.prepend(base);
  doc.querySelectorAll("[target]").forEach((el) => el.removeAttribute("target"));
  linkifyBareUrls(doc);

  // Embedded one-pagers (onboard / school site) wrap their content in a hero
  // with `min-height: 100vh` AND pin a `position: sticky` top bar (`.topbar`,
  // with a `backdrop-filter` blur). In the short preview iframe that sticky bar
  // stays pinned to the top and, together with the masthead below it, fills the
  // visible area, so the panel reads as just a header band with the real
  // handout content stranded below the fold (the bug in the screenshot).
  //
  // Neutralize the viewport-locked heights AND demote the sticky/fixed chrome
  // to static so the document flows naturally from the top and the actual
  // content is visible immediately. Appended last so it wins the cascade.
  const fit = doc.createElement("style");
  fit.id = "sr-preview-fit";
  fit.textContent =
    "html,body{height:auto!important;min-height:0!important}" +
    "body{display:block!important}" +
    "body>*{min-height:0!important}" +
    // Demote any sticky/fixed chrome (the handouts' .topbar, plus common header
    // class names) so it scrolls with the content instead of clipping the
    // short preview. Drop the backdrop blur which only reads as haze at this
    // size.
    ".topbar,.top-bar,[class*='topbar'],[class*='top-bar']," +
    "header,[class*='site-header'],[class*='nav-bar']" +
    "{position:static!important;top:auto!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}";
  doc.head.appendChild(fit);

  const srcdoc = `<!doctype html>\n${doc.documentElement.outerHTML}`;
  embeddedCache.set(url, srcdoc);
  return srcdoc;
}

async function loadEmbed(href, requestId) {
  const url = new URL(href, location.href);
  preview.frame.title = `${preview.title.textContent} preview`;
  preview.frame.removeAttribute("src");
  preview.frame.removeAttribute("srcdoc");

  if (url.origin === location.origin) {
    preview.frame.src = href;
    return;
  }

  try {
    const srcdoc = await embeddedHtml(url.href);
    if (requestId === previewRequestId) preview.frame.srcdoc = srcdoc;
  } catch {
    if (requestId === previewRequestId) preview.frame.src = href;
  }
}

function selectCard(card) {
  const requestId = ++previewRequestId;
  const kind = card.dataset.previewKind || "links";
  const href = card.getAttribute("href") || "";
  const label = text(card, ".link-card-title");

  cards.forEach((item) => item.setAttribute("aria-current", item === card ? "true" : "false"));
  preview.kicker.textContent = text(card, ".link-card-eyebrow");
  preview.title.textContent = label;
  preview.desc.textContent = text(card, ".link-card-desc");
  preview.note.textContent = card.dataset.linkNote || "";
  preview.primary.href = href;
  preview.primary.textContent = kind === "embed" ? "open full page" : "open link";
  preview.url.textContent = sameOriginPath(href);
  preview.behavior.textContent = kind === "embed" ? "inline preview" : "curated link card";

  if (kind === "embed") {
    preview.frameShell.hidden = false;
    preview.links.hidden = true;
    loadEmbed(href, requestId);
  } else {
    preview.frame.removeAttribute("src");
    preview.frame.removeAttribute("srcdoc");
    preview.frameShell.hidden = true;
    preview.links.hidden = false;
  }
}

cards.forEach((card) => {
  card.addEventListener("click", (event) => {
    event.preventDefault();
    selectCard(card);
  });
});

if (cards.length) selectCard(cards.find((card) => card.getAttribute("aria-current") === "true") || cards[0]);
