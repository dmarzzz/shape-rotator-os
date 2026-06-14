#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".docx", ".pdf", ".rtf"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/prepare-otter-slides-manifest.js --dir otter-export-dir [--conversation-id ID] [--title TITLE] [--out otter-manifest.json] [--no-recursive]",
    "",
    "Scans an exported Otter conversation folder and writes a manifest for:",
    "  npm run artifacts:otter -- --manifest otter-manifest.json --session-id SESSION_ID",
  ].join("\n");
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { recursive: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--dir") out.dir = argv[++i];
    else if (arg === "--conversation-id") out.conversationId = argv[++i];
    else if (arg === "--title") out.title = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--no-recursive") out.recursive = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function unixRel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function walkFiles(root, { recursive = true } = {}) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) visit(fullPath);
        continue;
      }
      if (entry.isFile()) out.push(fullPath);
    }
  };
  visit(root);
  return out;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function inferMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".txt") return "text/plain";
  if (ext === ".md") return "text/markdown";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".rtf") return "application/rtf";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

function classifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, ext).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "slides";
  if (AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext)) return "recording";
  if (!TEXT_EXTENSIONS.has(ext)) return null;
  if (/\b(summary|summaries|notes|recap)\b/.test(base)) return "summary";
  if (/\b(transcript|conversation|otter)\b/.test(base)) return "transcript";
  return null;
}

function providerResourceName({ conversationId, kind, hash, index }) {
  return `otter:${conversationId}:${kind}:${hash || `index-${index}`}`;
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function buildOtterSlidesManifest({ dir, conversationId, title, recursive = true, exportedAt = new Date().toISOString() } = {}) {
  if (!dir) throw new Error("--dir is required");
  const root = path.resolve(dir);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${root}`);
  const resolvedConversationId = slug(conversationId || path.basename(root)) || "otter-export";
  const files = walkFiles(root, { recursive }).sort((a, b) => naturalSort(unixRel(root, a), unixRel(root, b)));
  let nextSlideNumber = 1;

  const artifacts = files
    .map((filePath, index) => {
      const kind = classifyFile(filePath);
      if (!kind) return null;
      const rel = unixRel(root, filePath);
      const hash = sha256File(filePath);
      const stats = fs.statSync(filePath);
      const artifact = {
        kind,
        file: rel,
        storage_ref: `otter-export://${resolvedConversationId}/${rel}`,
        provider_resource_name: providerResourceName({
          conversationId: resolvedConversationId,
          kind,
          hash,
          index,
        }),
        title: path.basename(filePath),
        mime_type: inferMimeType(filePath),
        size_bytes: stats.size,
        source_hash: hash,
        export_source: "otter_export_folder",
      };
      if (kind === "slides") {
        artifact.slide_number = nextSlideNumber;
        artifact.page_label = `slide ${nextSlideNumber}`;
        nextSlideNumber += 1;
      }
      return artifact;
    })
    .filter(Boolean);

  return {
    provider: "otter",
    conversation_id: resolvedConversationId,
    title: title || null,
    export_source: "otter_export_folder",
    exported_at: exportedAt,
    artifacts,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs();
    if (opts.help) {
      console.log(usage());
      return;
    }
    const manifest = buildOtterSlidesManifest(opts);
    const json = JSON.stringify(manifest, null, 2) + "\n";
    if (opts.out && opts.out !== "-") {
      fs.writeFileSync(path.resolve(opts.out), json);
    } else {
      process.stdout.write(json);
    }
  } catch (error) {
    console.error(error.message || String(error));
    console.error(usage());
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  buildOtterSlidesManifest,
  classifyFile,
  inferMimeType,
  parseArgs,
};
