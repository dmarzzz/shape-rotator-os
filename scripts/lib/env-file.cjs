const fs = require("node:fs");
const path = require("node:path");

function unquoteEnvValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    if (quote === "\"") {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
    }
    return inner;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseEnvFile(text) {
  const values = {};
  String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) throw new Error(`invalid env line ${index + 1}`);
      values[match[1]] = unquoteEnvValue(match[2]);
    });
  return values;
}

function loadEnvFile(filePath, {
  cwd = process.cwd(),
  env = process.env,
  override = false,
} = {}) {
  if (!filePath) return {};
  const resolved = path.resolve(cwd, filePath);
  const values = parseEnvFile(fs.readFileSync(resolved, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (override || env[key] == null || env[key] === "") {
      env[key] = value;
    }
  }
  return values;
}

module.exports = {
  loadEnvFile,
  parseEnvFile,
};
