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

function selectCard(card) {
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
    preview.frame.title = `${label} preview`;
    if (preview.frame.getAttribute("src") !== href) preview.frame.src = href;
    preview.frameShell.hidden = false;
    preview.links.hidden = true;
  } else {
    preview.frame.removeAttribute("src");
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
