#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
const ARTICLE_DIR = path.join(ROOT, "cohort-data", "articles");
const WEB_JOURNAL_DIR = path.join(ROOT, "apps", "web", "workspace", "journal");
const WEB_ARTICLES_DIR = path.join(WEB_JOURNAL_DIR, "articles");
const WEB_ROOT = path.join(ROOT, "apps", "web");
const SITE = "https://os-web.shaperotator.xyz";
const PUBLIC_VERSION = "v0.0.4";
const PUBLIC_DATE = "2026-06-10";

const articleRoutes = {
  "what-thirteen-teams-shipped-last-week": {
    webSlug: "what-thirteen-teams-shipped-last-week",
    anchor: "cohort-recap",
    tags: ["WDYDLW", "cohort standup", "PMF journey"],
    topicLinks: ["PMF deltas", "Cohort distribution"],
  },
  "why-llm-agents-need-memory-workflows-and-social-routing": {
    webSlug: "llm-agents-memory-workflows-social-routing",
    anchor: "ai-agents",
    tags: ["LLM agents", "workflow memory", "human override"],
    topicLinks: ["Memory persistence", "Workflow routing"],
  },
  "privacy-is-not-the-product-capability-is-the-product": {
    webSlug: "private-ai-capability",
    anchor: "private-ai",
    tags: ["private AI", "trust", "capability"],
    topicLinks: ["Partial trust", "Privacy-preserving intelligence"],
  },
  "verifiability-is-becoming-ux-for-ai-infrastructure": {
    webSlug: "verifiability-is-becoming-ux-for-ai-infrastructure",
    anchor: "verifiability",
    tags: ["verifiability", "TEE UX", "dstack"],
    topicLinks: ["Verifiable infrastructure", "Attestation UX"],
  },
};

const articleOrder = [
  "what-thirteen-teams-shipped-last-week",
  "why-llm-agents-need-memory-workflows-and-social-routing",
  "privacy-is-not-the-product-capability-is-the-product",
  "verifiability-is-becoming-ux-for-ai-infrastructure",
];

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}

function slugId(s) {
  return String(s || "section")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "section";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, body) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, body.endsWith("\n") ? body : `${body}\n`);
}

function repoPath(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function parseArticle(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`missing frontmatter: ${file}`);
  const data = yaml.load(match[1]) || {};
  const body = match[2].trim();
  const slug = data.slug || path.basename(file, ".md");
  const route = articleRoutes[slug];
  if (!route) return null;
  return {
    ...data,
    slug,
    webSlug: route.webSlug,
    anchor: route.anchor,
    tags: route.tags,
    topicLinks: route.topicLinks,
    body,
    bodyWithoutTitle: body.replace(/^# .+\n+/, "").trim(),
    sourceFile: repoPath(file),
  };
}

function inlineMarkdown(text) {
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    return `<a href="${escAttr(url)}">${label}</a>`;
  });
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

function isFence(line) {
  return /^```/.test(line.trim());
}

function isHeading(line) {
  return /^#{2,4}\s+/.test(line);
}

function isUl(line) {
  return /^\s*-\s+/.test(line);
}

function isOl(line) {
  return /^\s*\d+\.\s+/.test(line);
}

function isBlockquote(line) {
  return /^\s*>\s?/.test(line);
}

function isTableStart(lines, i) {
  return (
    lines[i]?.includes("|")
    && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1] || "")
  );
}

function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(lines, i) {
  const headers = tableCells(lines[i]);
  let j = i + 2;
  const rows = [];
  while (j < lines.length && lines[j].includes("|") && lines[j].trim()) {
    rows.push(tableCells(lines[j]));
    j += 1;
  }
  const thead = `<thead><tr>${headers.map((h) => `<th>${inlineMarkdown(h)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${inlineMarkdown(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return { html: `<div class="table-wrap"><table>${thead}${tbody}</table></div>`, next: j };
}

function renderMarkdown(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let i = 0;
  let openSubsection = false;

  const closeSubsection = () => {
    if (openSubsection) {
      out.push("</div></details>");
      openSubsection = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (isFence(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const rendered = renderTable(lines, i);
      out.push(rendered.html);
      i = rendered.next;
      continue;
    }

    if (isHeading(line)) {
      const [, hashes, text] = line.match(/^(#{2,4})\s+(.+)$/);
      const level = Math.min(hashes.length, 4);
      if (level <= 3) closeSubsection();
      if (level === 3) {
        out.push(`<details class="article-subsection"><summary><h3 id="${escAttr(slugId(text))}">${inlineMarkdown(text)}</h3></summary><div class="article-subsection-body">`);
        openSubsection = true;
        i += 1;
        continue;
      }
      out.push(`<h${level} id="${escAttr(slugId(text))}">${inlineMarkdown(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (isBlockquote(line)) {
      const quote = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote><p>${inlineMarkdown(quote.join(" "))}</p></blockquote>`);
      continue;
    }

    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (i < lines.length && (ordered ? isOl(lines[i]) : isUl(lines[i]))) {
        items.push(lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*-\s+/, ""));
        i += 1;
      }
      out.push(`<${tag}>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (
      i < lines.length
      && lines[i].trim()
      && !isHeading(lines[i])
      && !isUl(lines[i])
      && !isOl(lines[i])
      && !isBlockquote(lines[i])
      && !isFence(lines[i])
      && !isTableStart(lines, i)
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  }
  closeSubsection();
  return out.join("\n        ");
}

function articleSections(article) {
  return article.bodyWithoutTitle
    .split("\n")
    .map((line) => line.match(/^(#{2,3})\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      depth: match[1].length,
      title: match[2],
      id: slugId(match[2]),
    }));
}

function articleUrl(article) {
  return `${SITE}/workspace/journal/articles/${article.webSlug}`;
}

function articlePath(article) {
  return `/workspace/journal/articles/${article.webSlug}/`;
}

function articleKeywords(article) {
  const bits = [
    article.editorial_section,
    ...(article.related_clusters || []),
    ...(article.related_teams || []),
    ...article.tags,
  ].filter(Boolean);
  return [...new Set(bits)].join(", ");
}

function renderArticleMenu(article, articles) {
  const articleLinks = articles.map((candidate) => {
    const current = candidate.slug === article.slug;
    const currentClass = current ? ` class="is-current"` : "";
    return `<a${currentClass} href="${articlePath(candidate)}">
          <span>${esc(candidate.title)}</span>
          <small>${esc(candidate.editorial_section || "")}</small>
        </a>`;
  }).join("\n        ");
  const sections = articleSections(article);
  const sectionLinks = sections.filter((section) => section.depth === 2).map((section) => {
    return `<a class="depth-${section.depth}" href="#${escAttr(section.id)}">${esc(section.title)}</a>`;
  }).join("\n          ");
  const subsectionLinks = sections.filter((section) => section.depth > 2).map((section) => {
    return `<a class="depth-${section.depth}" href="#${escAttr(section.id)}">${esc(section.title)}</a>`;
  }).join("\n            ");
  const subsectionBlock = subsectionLinks ? `
        <details class="submenu">
          <summary>Subsections</summary>
          <nav class="menu-list section-list subsection-list">
            ${subsectionLinks}
          </nav>
        </details>` : "";
  return `
      <aside class="article-menu" aria-label="article navigation" data-article-menu>
        <div class="menu-heading">
          <p class="menu-label">Articles</p>
          <button class="menu-toggle" type="button" data-menu-toggle aria-expanded="true" aria-controls="article-menu-list">hide</button>
        </div>
        <nav class="menu-list article-menu-list" id="article-menu-list">
        ${articleLinks}
        </nav>
        <p class="menu-label">Sections</p>
        <nav class="menu-list section-list">
          ${sectionLinks}
        </nav>
${subsectionBlock}
      </aside>`;
}

function renderArticlePage(article, articles) {
  const description = article.working_angle || `${article.title} - Shape Rotator article.`;
  const bodyHtml = renderMarkdown(article.bodyWithoutTitle);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(article.title)}</title>
  <meta name="description" content="${escAttr(description)}" />
  <link rel="canonical" href="${articleUrl(article)}" />
  <meta property="og:title" content="${escAttr(article.title)}" />
  <meta property="og:description" content="${escAttr(description)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${articleUrl(article)}" />
  <meta property="og:image" content="${SITE}/workspace/workspace.jpg" />
  <link rel="stylesheet" href="/workspace/journal/article.css" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <script type="application/ld+json">
    ${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: article.title,
      description,
      datePublished: PUBLIC_DATE,
      dateModified: PUBLIC_DATE,
      author: { "@type": "Organization", name: "Shape Rotator" },
      publisher: { "@type": "Organization", name: "Shape Rotator" },
      keywords: articleKeywords(article),
      mainEntityOfPage: articleUrl(article),
    }, null, 6)}
  </script>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <nav class="nav" aria-label="primary">
        <a href="/">[SHAPE_ROTATOR]</a>
        <a href="/workspace">[ WORKSPACE ]</a>
        <a href="/workspace/journal">[ JOURNAL ]</a>
      </nav>
      <span class="meta">ARTICLE ${esc(article.content_version || "")}</span>
    </header>

    <div class="article-layout">
${renderArticleMenu(article, articles)}
      <div class="article-content">
        <article>
          <header class="article-header">
            <p class="eyebrow">${esc(article.editorial_section || "article")}</p>
            <h1>${esc(article.title)}</h1>
            <p class="dek">${esc(description)}</p>
            <div class="actions">
              <button class="button" type="button" data-copy-md>[ COPY MD ]</button>
              <a class="button" href="article.md" data-md-url>[ RAW MD ]</a>
              <a class="button" href="article.md" download>[ DOWNLOAD ]</a>
              <span class="copy-status" data-copy-status aria-live="polite"></span>
            </div>
            <div class="tag-row" aria-label="tags">
              ${article.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("\n              ")}
            </div>
          </header>

          <div class="article-body">
            ${bodyHtml}
          </div>
        </article>

        <section class="copy-panel" aria-labelledby="copy-title">
          <details>
            <summary id="copy-title">Copyable Markdown</summary>
            <textarea readonly data-md-fallback>${esc(article.body)}</textarea>
          </details>
        </section>
      </div>
    </div>

    <footer class="footer">
      <span>Shape Rotator Journal</span>
      <span><a href="/workspace/journal">Index</a> / <a href="/workspace/journal/llms.txt">LLM list</a></span>
    </footer>
  </main>
  <script src="/workspace/journal/copy-article.js"></script>
  <script>
    const articleMenu = document.querySelector('[data-article-menu]');
    const menuToggle = document.querySelector('[data-menu-toggle]');
    const articleHeader = document.querySelector('.article-header');

    if (articleMenu && menuToggle && articleHeader) {
      let manualMenuChoice = false;

      const setArticleMenuCollapsed = (collapsed) => {
        articleMenu.classList.toggle('is-compact', collapsed);
        menuToggle.textContent = collapsed ? 'show' : 'hide';
        menuToggle.setAttribute('aria-expanded', String(!collapsed));
      };

      const syncArticleMenu = () => {
        if (window.scrollY < 80) manualMenuChoice = false;
        if (manualMenuChoice) return;
        setArticleMenuCollapsed(articleHeader.getBoundingClientRect().bottom < 90);
      };

      menuToggle.addEventListener('click', () => {
        manualMenuChoice = true;
        setArticleMenuCollapsed(!articleMenu.classList.contains('is-compact'));
      });

      document.querySelectorAll('.section-list a').forEach((link) => {
        link.addEventListener('click', () => {
          manualMenuChoice = false;
          setArticleMenuCollapsed(true);
        });
      });

      const openHashSubsection = () => {
        if (!window.location.hash) return;
        const id = decodeURIComponent(window.location.hash.slice(1));
        const target = document.getElementById(id);
        const subsection = target?.closest?.('.article-subsection');
        if (subsection) subsection.open = true;
      };

      window.addEventListener('scroll', syncArticleMenu, { passive: true });
      window.addEventListener('hashchange', () => {
        manualMenuChoice = false;
        setArticleMenuCollapsed(true);
        openHashSubsection();
      });
      openHashSubsection();
      syncArticleMenu();
    }
  </script>
</body>
</html>`;
}

function renderIndex(articles) {
  const articleJson = articles.map((article) => ({
    "@type": "BlogPosting",
    headline: article.title,
    url: articleUrl(article),
    keywords: articleKeywords(article),
  }));
  const articleRows = articles.map((article) => `
        <article class="article" id="${escAttr(article.anchor)}">
          <time class="meta" datetime="${PUBLIC_DATE}">May 29</time>
          <div class="article-main">
            <h3 class="article-title"><a href="${articlePath(article)}">${esc(article.title)}</a></h3>
            <p class="article-summary">${esc(article.working_angle || "")}</p>
          </div>
          <div class="article-tools">
            <div class="article-links">
              <a href="${articlePath(article)}">READ</a>
              <a href="${articlePath(article)}article.md">MD</a>
            </div>
            <div class="tag-row" aria-label="tags">
              ${article.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("\n              ")}
            </div>
          </div>
        </article>`).join("\n");
  const topicLinks = articles.flatMap((article) => article.topicLinks.map((label) => `
          <a href="${articlePath(article)}">${esc(label)} <small>article</small></a>`)).join("\n");
  const exportBlock = renderIndexMarkdown(articles);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>shape rotator journal</title>
  <meta name="description" content="Shape Rotator journal: source-backed articles on agent memory, private AI capability, and verifiability UX." />
  <link rel="canonical" href="${SITE}/workspace/journal" />
  <meta property="og:title" content="shape rotator journal" />
  <meta property="og:description" content="Source-backed articles on agent memory, private AI capability, and verifiability UX." />
  <meta property="og:type" content="blog" />
  <meta property="og:url" content="${SITE}/workspace/journal" />
  <meta property="og:image" content="${SITE}/workspace/workspace.jpg" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');
    :root { --bg:#fff; --fg:#050505; --muted:#767676; --soft:#f7f7f3; --line:1px solid var(--fg); --soft-line:1px dotted rgba(5,5,5,.28); --mono:'JetBrains Mono',monospace; --pad:clamp(12px,2vw,24px); --max:1080px; }
    * { box-sizing:border-box; margin:0; padding:0; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
    html, body { min-height:100%; background:var(--bg); color:var(--fg); font-family:var(--mono); font-size:13px; line-height:1.45; letter-spacing:0; }
    body::before { content:""; position:fixed; inset:0; z-index:30; pointer-events:none; background:linear-gradient(to bottom,transparent,transparent 50%,rgba(0,0,0,.018) 50%,rgba(0,0,0,.018)); background-size:100% 4px; }
    a, button { color:inherit; font:inherit; } a { text-decoration:none; } button { border:0; background:none; cursor:pointer; }
    a:focus-visible, button:focus-visible { outline:var(--line); outline-offset:2px; }
    .shell { width:min(100%,var(--max)); min-height:100dvh; margin:0 auto; border-left:var(--line); border-right:var(--line); background:var(--bg); }
    .topbar, .footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px var(--pad); font-size:11px; font-weight:700; text-transform:uppercase; }
    .topbar { min-height:38px; border-bottom:var(--line); } .footer { color:var(--muted); border-top:var(--line); }
    .nav, .status, .actions, .topics, .article-links, .tag-row, .mechanism-list, .project-list, .view-toggle { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    .nav a, .nav span, .status span, .chip, .button, .article-links a, .article-links button { min-height:24px; display:inline-flex; align-items:center; border:var(--line); padding:3px 7px; font-size:10px; font-weight:700; text-transform:uppercase; }
    .nav a, .nav span, .status span { border:0; padding:0; }
    .nav a + a, .nav a + span { padding-left:10px; border-left:var(--soft-line); }
    .nav a:hover, .chip:hover, .button:hover, .article:hover, .article-links a:hover, .article-links button:hover { background:var(--fg); color:var(--bg); }
    .status { color:var(--muted); font-weight:500; }
    .hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(220px,320px); gap:20px; padding:24px var(--pad); border-bottom:var(--line); }
    .eyebrow, .meta, .tag, .copy-status { color:var(--muted); font-size:10px; font-weight:700; text-transform:uppercase; }
    h1 { max-width:780px; margin-top:8px; font-size:clamp(28px,4vw,42px); line-height:1.05; font-weight:700; letter-spacing:0; text-transform:uppercase; }
    .lede { max-width:760px; margin-top:12px; font-size:13px; }
    .actions { align-content:end; justify-content:flex-end; }
    .topics { padding:10px var(--pad); border-bottom:var(--line); }
    .view-toggle { margin-top:12px; }
    .view-toggle button.is-active { background:var(--fg); color:var(--bg); }
    body[data-summary="titles"] .article-summary { display:none; }
    .intro { display:grid; grid-template-columns:120px minmax(0,1fr); gap:16px; padding:18px var(--pad); border-bottom:var(--line); background:var(--soft); }
    .intro-copy { display:grid; gap:13px; } .intro h2 { font-size:15px; line-height:1.25; text-transform:uppercase; } .intro p { max-width:800px; font-size:12px; }
    .question { padding:10px; border:var(--line); background:var(--bg); font-size:12px; font-weight:700; }
    .mechanism-list, .project-list { gap:5px; }
    .topic-map { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); border-top:var(--line); border-left:var(--line); }
    .topic-map a, .topic-map span { min-height:30px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 8px; border-right:var(--line); border-bottom:var(--line); font-size:10px; font-weight:700; text-transform:uppercase; }
    .topic-map a:hover { background:var(--fg); color:var(--bg); } .topic-map a:hover small { color:var(--bg); } .topic-map small { color:var(--muted); font-size:10px; font-weight:700; }
    .section-head { display:grid; grid-template-columns:120px 1fr; gap:16px; padding:14px var(--pad) 10px; border-bottom:var(--line); }
    .section-head h2 { font-size:13px; line-height:1.3; font-weight:700; text-transform:uppercase; }
    .article-list { display:grid; }
    .article { display:grid; grid-template-columns:120px minmax(0,1fr) 210px; gap:16px; padding:16px var(--pad); border-bottom:var(--line); }
    .article-main { min-width:0; } .article-title { max-width:720px; font-size:clamp(17px,2vw,23px); line-height:1.12; font-weight:700; text-transform:uppercase; }
    .article-summary { max-width:720px; margin-top:7px; color:var(--muted); font-size:12px; }
    .article:hover .article-summary, .article:hover .meta, .article:hover .tag { color:var(--bg); }
    .article-tools { display:grid; align-content:start; justify-items:end; gap:8px; } .article-links { justify-content:flex-end; } .tag-row { justify-content:flex-end; gap:5px; }
    .tag { min-height:20px; display:inline-flex; align-items:center; padding:2px 5px; border:var(--soft-line); }
    .llm-export { padding:16px var(--pad) 20px; background:var(--soft); }
    details { border:var(--line); background:var(--bg); } summary { min-height:32px; display:flex; align-items:center; padding:7px 10px; border-bottom:var(--line); cursor:pointer; font-size:10px; font-weight:700; text-transform:uppercase; }
    textarea { width:100%; min-height:150px; display:block; border:0; resize:vertical; padding:10px; background:var(--bg); color:var(--fg); font:12px/1.5 var(--mono); letter-spacing:0; }
    @media (max-width:760px) { .shell { border-left:0; border-right:0; } .topbar, .footer, .hero, .intro, .section-head, .article { grid-template-columns:1fr; } .topbar, .footer { align-items:flex-start; flex-direction:column; } .actions, .article-tools, .article-links, .tag-row { justify-content:flex-start; justify-items:start; } .topic-map { grid-template-columns:1fr; } }
  </style>
  <script type="application/ld+json">
    ${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Blog",
      name: "shape rotator journal",
      description: "Source-backed articles on agent memory, private AI capability, and verifiability UX.",
      url: `${SITE}/workspace/journal`,
      publisher: { "@type": "Organization", name: "Shape Rotator" },
      blogPost: articleJson,
    }, null, 6)}
  </script>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <nav class="nav" aria-label="primary">
        <a href="/">[SHAPE_ROTATOR]</a>
        <a href="/workspace">[ WORKSPACE ]</a>
        <span>[ JOURNAL ]</span>
      </nav>
      <div class="status"><span>PUBLIC_CONTENT ${PUBLIC_VERSION}</span></div>
    </header>

    <section class="hero" aria-labelledby="page-title">
      <div>
        <p class="eyebrow">Shape Rotator Journal</p>
        <h1 id="page-title">Articles for people and LLMs</h1>
        <p class="lede">Source-backed Shape Rotator articles mirrored from the OS content vault. Each page ships readable HTML plus raw Markdown for copying, exporting, and model retrieval.</p>
      </div>
      <div class="actions" aria-label="journal actions">
        <button class="button" type="button" data-copy-index>[ COPY INDEX MD ]</button>
        <div class="view-toggle" aria-label="article list view">
          <button class="button is-active" type="button" data-summary-mode="context">[ TITLES + SUBTITLES ]</button>
          <button class="button" type="button" data-summary-mode="titles">[ TITLES ONLY ]</button>
        </div>
        <a class="button" href="/workspace/journal/index.md">[ RAW INDEX ]</a>
        <a class="button" href="/workspace/journal/llms.txt">[ LLM LIST ]</a>
        <span class="copy-status" data-copy-status aria-live="polite"></span>
      </div>
    </section>

    <nav class="topics" aria-label="topics">
      ${articles.map((article) => `<a class="chip" href="#${escAttr(article.anchor)}">${esc(article.editorial_section || article.title)}</a>`).join("\n      ")}
    </nav>

    <section class="intro" aria-labelledby="synthesis-title">
      <p class="meta">Synthesis</p>
      <div class="intro-copy">
        <div>
          <p class="eyebrow">Shape Rotator - Full Context Synthesis</p>
          <h2 id="synthesis-title">Meta theme across the article set</h2>
        </div>
        <p>The shared thread is coordination under partial trust: agent work needs durable memory and social routing; private AI infrastructure needs to unlock concrete capability; verifiability has to become something users can see and act on.</p>
        <div class="mechanism-list" aria-label="recurring mechanisms">
          <span class="tag">coordination under partial trust</span>
          <span class="tag">durable memory</span>
          <span class="tag">local-first systems</span>
          <span class="tag">trusted execution</span>
          <span class="tag">attestation UX</span>
          <span class="tag">human override</span>
          <span class="tag">workflow routing</span>
          <span class="tag">capability-first privacy</span>
        </div>
        <p class="question">How do humans, agents, workflows, and organizations coordinate effectively when context, trust, privacy, and memory are all fragmented?</p>
        <div class="topic-map" aria-label="article topic links">
${topicLinks}
        </div>
      </div>
    </section>

    <section aria-labelledby="latest-title">
      <header class="section-head">
        <p class="meta">Latest</p>
        <h2 id="latest-title">Published articles</h2>
      </header>

      <div class="article-list">
${articleRows}
      </div>
    </section>

    <section class="llm-export" aria-labelledby="export-title">
      <details>
        <summary id="export-title">LLM export block</summary>
        <textarea readonly data-index-export>${esc(exportBlock)}</textarea>
      </details>
    </section>

    <footer class="footer">
      <span>Shape Rotator OS</span>
      <span><a href="/workspace">Workspace</a> / <a href="/links">Links</a> / <a href="https://github.com/dmarzzz/shape-rotator-os">Source</a></span>
    </footer>
  </main>

  <script>
    const copyButton = document.querySelector('[data-copy-index]');
    const copyStatus = document.querySelector('[data-copy-status]');
    const exportText = document.querySelector('[data-index-export]');
    const viewButtons = Array.from(document.querySelectorAll('[data-summary-mode]'));

    copyButton.addEventListener('click', async () => {
      const text = exportText.value.trim();
      try {
        await navigator.clipboard.writeText(text + '\\n');
        copyStatus.textContent = 'copied';
      } catch (error) {
        copyStatus.textContent = 'select text below';
      }
    });

    viewButtons.forEach((button) => {
      button.addEventListener('click', () => {
        const mode = button.dataset.summaryMode || 'context';
        document.body.dataset.summary = mode;
        viewButtons.forEach((candidate) => {
          candidate.classList.toggle('is-active', candidate === button);
        });
      });
    });
  </script>
</body>
</html>`;
}

function renderIndexMarkdown(articles) {
  const lines = [
    "# Shape Rotator Journal",
    "",
    `Version: public content ${PUBLIC_VERSION}`,
    "",
    "Use this as a compact retrieval index for Shape Rotator articles.",
    "",
    "## Articles",
    "",
  ];
  for (const article of articles) {
    lines.push(`- ${article.title}`);
    lines.push(`  - HTML: ${articleUrl(article)}`);
    lines.push(`  - Markdown: ${articleUrl(article)}/article.md`);
    lines.push(`  - Version: ${article.content_version || ""}`);
    lines.push(`  - Section: ${article.editorial_section || ""}`);
    lines.push(`  - Tags: ${article.tags.join(", ")}`);
    lines.push(`  - Source file: ${article.sourceFile}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function renderJournalLlms(articles) {
  const topics = [...new Set(articles.flatMap((article) => [
    article.editorial_section,
    ...(article.related_clusters || []),
    ...(article.related_teams || []),
    ...article.tags,
  ]).filter(Boolean))];
  return [
    "# Shape Rotator Journal",
    "",
    `Version: public content ${PUBLIC_VERSION}`,
    "",
    "This file lists the current journal articles and their raw Markdown sources for LLM retrieval, copy/paste, and citation.",
    "",
    "## Current articles",
    "",
    ...articles.flatMap((article) => [
      `- ${articleUrl(article)}`,
      `- ${articleUrl(article)}/article.md`,
      "",
    ]),
    "## Topic map",
    "",
    ...topics.map((topic) => `- ${topic}`),
    "",
  ].join("\n");
}

function renderRootLlms(articles) {
  return [
    "# Shape Rotator OS",
    "",
    "> Public web surface for the Shape Rotator cohort and workspace.",
    "",
    `Public content version: ${PUBLIC_VERSION}`,
    "",
    "Important pages:",
    "",
    `- [Workspace](${SITE}/workspace): immersive Shape Rotator control-room surface.`,
    `- [Workspace journal](${SITE}/workspace/journal): source-backed articles on agent memory, private AI capability, and verifiability UX.`,
    `- [Journal LLM list](${SITE}/workspace/journal/llms.txt): raw article links and Markdown sources for LLM retrieval.`,
    `- [Cohort](${SITE}/cohort): public cohort viewer.`,
    `- [Calendar](${SITE}/calendar): public program calendar.`,
    `- [Links](${SITE}/links): important project links.`,
    "",
    "Journal article sources:",
    "",
    ...articles.map((article) => `- [${article.title}](${articleUrl(article)}/article.md)`),
    "",
  ].join("\n");
}

function renderSitemap(articles) {
  const urls = [
    "/",
    "/cohort",
    "/calendar",
    "/availability",
    "/workspace",
    "/workspace/journal",
    ...articles.map((article) => `/workspace/journal/articles/${article.webSlug}`),
    "/links",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${SITE}${u}</loc>\n  </url>`).join("\n")}
</urlset>`;
}

function main() {
  const articles = articleOrder
    .map((slug) => path.join(ARTICLE_DIR, `${slug}.md`))
    .map(parseArticle)
    .filter(Boolean);

  for (const article of articles) {
    const outDir = path.join(WEB_ARTICLES_DIR, article.webSlug);
    writeFile(path.join(outDir, "article.md"), article.body);
    writeFile(path.join(outDir, "index.html"), renderArticlePage(article, articles));
  }

  writeFile(path.join(WEB_JOURNAL_DIR, "index.html"), renderIndex(articles));
  writeFile(path.join(WEB_JOURNAL_DIR, "index.md"), renderIndexMarkdown(articles));
  writeFile(path.join(WEB_JOURNAL_DIR, "llms.txt"), renderJournalLlms(articles));
  writeFile(path.join(WEB_ROOT, "llms.txt"), renderRootLlms(articles));
  writeFile(path.join(WEB_ROOT, "sitemap.xml"), renderSitemap(articles));

  console.log(`[build-web-journal] wrote ${articles.length} article pages`);
}

main();
