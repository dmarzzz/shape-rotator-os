// Boot-load guard. The Electron MAIN process (main.js) and its preload run
// before any renderer/unit test or static asar analysis can see them, so a
// require() of a local module that doesn't exist on the branch throws at boot
// and the app never starts — invisible to the rest of the suite. A stray
// `require("./self-report-node")` for a file that lived only on another branch
// shipped exactly this once (the app wouldn't launch). Pin it: every local
// require in main.js / preload.js must resolve to a real file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function unresolvedLocalRequires(file) {
  const src = readFileSync(resolve(here, file), "utf8");
  const re = /\brequire\((["'])(\.[^"']+)\1\)/g;
  const missing = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[2];
    try {
      require.resolve(resolve(here, spec));
    } catch {
      missing.push(spec);
    }
  }
  return missing;
}

for (const file of ["main.js", "preload.js"]) {
  test(`every local require() in ${file} resolves to a real file`, () => {
    const missing = unresolvedLocalRequires(file);
    assert.deepEqual(missing, [], `${file} require()s missing local modules: ${missing.join(", ")}`);
  });
}
