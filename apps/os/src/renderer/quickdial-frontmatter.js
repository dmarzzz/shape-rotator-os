// quickdial-frontmatter — append one chip to a person-record frontmatter
// list (seeking / offering) via TEXT surgery. DOM-free so the quick dial
// and tests share one implementation.
//
// Surgery, not YAML round-tripping: person files carry hand-written
// comments and ordering that yaml.dump would destroy. Everything outside
// the touched lines stays byte-identical, so the PR diff is one line.

import yaml from "js-yaml";

// Mirrors quoteYaml in alchemy.js (kept local so this module stays free
// of the alchemy import graph — it's two lines, drift is detectable).
function quoteYaml(s) {
  return `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Returns { text } with the chip appended, { unchanged: true } when the
 * chip is already present (case-insensitive), or { error } when the file
 * can't be edited safely.
 */
export function appendChipToFrontmatter(text, field, chip) {
  const fmMatch = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fmMatch) return { error: "no frontmatter found" };
  const fm = fmMatch[2];
  const rest = text.slice(fmMatch[0].length);
  const quoted = quoteYaml(chip);
  const normalized = chip.trim().toLowerCase();

  const rebuild = (newFm) => ({ text: fmMatch[1] + newFm + fmMatch[3] + rest });

  const keyRe = new RegExp(`^${field}:([^\\n]*)$`, "m");
  const keyLine = fm.match(keyRe);
  if (!keyLine) {
    // key absent — add it at the end of the frontmatter
    return rebuild(`${fm}\n${field}:\n  - ${quoted}`);
  }

  const inline = keyLine[1].trim();
  const keyEnd = keyLine.index + keyLine[0].length;
  if (inline === "" || inline.startsWith("#")) {
    // block list — capture the run of "  - item" lines after the key
    const after = fm.slice(keyEnd);
    const itemsMatch = after.match(/^((?:\r?\n[ \t]+-[^\n]*)*)/);
    const items = itemsMatch ? itemsMatch[1] : "";
    let existing = [];
    try {
      existing = yaml.load(`${field}:${items}`)?.[field] || [];
    } catch {}
    if (existing.some((s) => String(s).trim().toLowerCase() === normalized)) {
      return { unchanged: true };
    }
    const insertAt = keyEnd + items.length;
    return rebuild(fm.slice(0, insertAt) + `\n  - ${quoted}` + fm.slice(insertAt));
  }

  // inline value (`seeking: []`, `seeking: [a, b]`) — parse it and
  // rewrite that one line as a block list carrying the old items
  let existing;
  try {
    existing = yaml.load(`x: ${inline}`)?.x;
  } catch {
    return { error: `couldn't parse the existing ${field} value` };
  }
  if (existing == null) existing = [];
  if (!Array.isArray(existing)) return { error: `${field} isn't a list in your profile` };
  if (existing.some((s) => String(s).trim().toLowerCase() === normalized)) {
    return { unchanged: true };
  }
  const block = `${field}:\n` + [...existing.map((s) => `  - ${quoteYaml(String(s))}`), `  - ${quoted}`].join("\n");
  return rebuild(fm.slice(0, keyLine.index) + block + fm.slice(keyEnd));
}
