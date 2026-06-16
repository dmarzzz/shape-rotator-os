import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const workflowsDir = path.resolve(".github/workflows");

function setupNodeSteps(workflow) {
  const steps = [];
  for (const job of Object.values(workflow.jobs || {})) {
    for (const step of job?.steps || []) {
      if (String(step?.uses || "").startsWith("actions/setup-node@")) steps.push(step);
    }
  }
  return steps;
}

test("GitHub workflows run npm scripts on the supported Node major", () => {
  let setupNodeCount = 0;
  for (const fileName of fs.readdirSync(workflowsDir).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
    const workflow = yaml.load(fs.readFileSync(path.join(workflowsDir, fileName), "utf8"));
    for (const step of setupNodeSteps(workflow)) {
      setupNodeCount += 1;
      assert.equal(String(step.with?.["node-version"] || ""), "24", `${fileName} should use Node 24`);
    }
  }

  assert.ok(setupNodeCount >= 1, "expected at least one actions/setup-node step");
});
