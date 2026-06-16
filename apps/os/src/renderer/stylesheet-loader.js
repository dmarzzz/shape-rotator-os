const stylesheetPromises = new Map();

function findStylesheet(href) {
  return [...document.querySelectorAll('link[rel="stylesheet"]')]
    .find((link) => link.getAttribute("href") === href);
}

export function loadStylesheetOnce(href) {
  const existing = findStylesheet(href);
  if (existing) return Promise.resolve(existing);
  const cached = stylesheetPromises.get(href);
  if (cached) return cached;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  const promise = new Promise((resolve) => {
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => {
      stylesheetPromises.delete(href);
      link.remove();
      console.warn(`[style] failed to load ${href}`);
      resolve(link);
    }, { once: true });
  });
  stylesheetPromises.set(href, promise);
  document.head.appendChild(link);
  return promise;
}
