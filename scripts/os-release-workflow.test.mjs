import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/os-release.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);
const require = createRequire(import.meta.url);
const { findPackedBinary } = require("../apps/os/scripts/after-pack-verify.cjs");

test("os-release fails fast when tag and package version diverge", () => {
  const steps = workflow.jobs.build.steps;
  const versionStep = steps.find((step) => step.name === "verify tag matches OS package version");

  assert.ok(versionStep, "release workflow must check tag/package version");
  assert.equal(versionStep.if, "startsWith(github.ref, 'refs/tags/v')");
  assert.equal(versionStep.shell, "bash");
  assert.match(versionStep.run, /GITHUB_REF_NAME#v/);
  assert.match(versionStep.run, /apps\/os\/package\.json/);
  assert.match(versionStep.run, /::error::Release tag/);
  assert.match(versionStep.run, /exit 1/);
});

test("os-release only promotes draft releases after every platform succeeds", () => {
  assert.equal(workflow.jobs.promote.needs, "build");
  assert.match(workflow.jobs.promote.if, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow.jobs.promote.if, /success\(\)/);
  assert.match(workflowText, /--draft=false/);
  assert.match(workflowText, /--prerelease/);
  assert.match(workflowText, /--latest/);
});

test("after-pack Linux smoke resolves the app binary instead of Electron helpers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "after-pack-linux-"));
  const helper = path.join(dir, "chrome-sandbox");
  const crashpad = path.join(dir, "chrome_crashpad_handler");
  const app = path.join(dir, "Shape Rotator OS");
  fs.writeFileSync(helper, "");
  fs.writeFileSync(crashpad, "");
  fs.writeFileSync(app, "");
  fs.chmodSync(helper, 0o755);
  fs.chmodSync(crashpad, 0o755);
  fs.chmodSync(app, 0o755);

  assert.equal(findPackedBinary(dir, "linux", "Shape Rotator OS"), app);
});
