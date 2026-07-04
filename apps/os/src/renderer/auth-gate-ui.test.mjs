import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const osRoot = path.resolve(here, "../../");

test("auth gate first paint is stable instead of animated or page-accent driven", () => {
  const gate = fs.readFileSync(path.join(osRoot, "src/renderer/auth-gate.js"), "utf8");

  assert.match(gate, /--ag-bg: rgb\(10, 10, 10\)/);
  assert.match(gate, /z-index: 100000/);
  assert.match(gate, /data-ag-state/);
  assert.match(gate, /min-height: 374px/);
  assert.match(gate, /backdrop-filter: blur\(28px\) saturate\(1\.25\)/);
  assert.match(gate, /background: rgba\(255,255,255,0\.92\)/);
  assert.match(gate, /Sign in to Shape OS/);
  assert.doesNotMatch(gate, /conic-gradient|ag-spin/);
});

test("auth gate skips no-op Matrix refresh renders", () => {
  const gate = fs.readFileSync(path.join(osRoot, "src/renderer/auth-gate.js"), "utf8");

  assert.match(gate, /const membershipKey = \(m\) => m/);
  assert.match(gate, /const prevUserId = _matrixUserId/);
  assert.match(gate, /const prevMembershipKey = membershipKey\(_matrixMembership\)/);
  assert.match(gate, /prevUserId !== _matrixUserId \|\| prevMembershipKey !== membershipKey\(_matrixMembership\)/);
});

test("theme application suppresses global color transitions", () => {
  const theme = fs.readFileSync(path.join(osRoot, "src/renderer/theme.js"), "utf8");
  const styles = fs.readFileSync(path.join(osRoot, "src/styles.css"), "utf8");

  assert.match(theme, /root\.classList\.add\("disable-transitions"\)/);
  assert.match(theme, /requestAnimationFrame\(\(\) => requestAnimationFrame\(unlock\)\)/);
  assert.match(styles, /html\.disable-transitions \*, html\.disable-transitions \*::before, html\.disable-transitions \*::after/);
  assert.match(styles, /transition: none !important/);
});
