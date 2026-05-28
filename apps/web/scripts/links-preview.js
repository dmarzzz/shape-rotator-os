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
