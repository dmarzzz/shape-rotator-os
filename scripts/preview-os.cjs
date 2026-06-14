// preview-os.cjs — tiny zero-dependency static server for browser-
// previewing the OS renderer (apps/os) outside Electron. Dev tooling
// only; never shipped. Serves apps/os at the repo-relative root so the
// renderer's `../node_modules/...` importmap paths resolve.
//
//   node scripts/preview-os.cjs [port]   (default 5177)

"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ROOT = path.join(REPO_ROOT, "apps", "os");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const PORT = Number(process.argv[2] || 5177);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (urlPath === "/") {
      res.writeHead(302, { location: "/src/index.html" }).end();
      return;
    }

    const base = urlPath.startsWith("/node_modules/") ? NODE_MODULES : ROOT;
    const rel = urlPath.startsWith("/node_modules/")
      ? urlPath.slice("/node_modules".length)
      : urlPath;
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    // Follow link-deps symlinks/junctions out of ROOT via realpath.
    const real = fs.realpathSync(file);
    const stat = fs.statSync(real);
    const target = stat.isDirectory() ? path.join(real, "index.html") : real;
    const body = fs.readFileSync(target);
    res.writeHead(200, {
      "content-type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.log(`[preview-os] serving ${ROOT} on http://localhost:${PORT}/`);
});
