import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const mainSource = fs.readFileSync(new URL("../apps/os/main.js", import.meta.url), "utf8");

test("Electron smoke mode isolates userData before profile migrations and state paths", () => {
  const smokeFlag = mainSource.indexOf("const SMOKE_TEST");
  const configureFn = mainSource.indexOf("function configureSmokeUserData()");
  const configureCall = mainSource.indexOf("configureSmokeUserData();");
  const migrateCall = mainSource.indexOf("migrateLegacyUserData();");
  const stateDir = mainSource.indexOf('const STATE_DIR = app.getPath("userData")');

  assert.ok(smokeFlag >= 0, "main.js should define SMOKE_TEST");
  assert.ok(configureFn > smokeFlag, "smoke userData isolation should be tied to SMOKE_TEST");
  assert.ok(configureCall > configureFn, "smoke userData isolation should be called");
  assert.ok(configureCall < migrateCall, "smoke userData must be set before legacy profile migration");
  assert.ok(configureCall < stateDir, "smoke userData must be set before state files are resolved");
  assert.match(mainSource, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), "shape-rotator-os-smoke-"\)\)/);
  assert.match(mainSource, /app\.setPath\("userData", dir\)/);
});
