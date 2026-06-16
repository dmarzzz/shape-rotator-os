import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const workflowPath = path.resolve(".github/workflows/os-release.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");
const workflow = yaml.load(workflowText);

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
