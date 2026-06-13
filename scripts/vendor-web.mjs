#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertInside(child, parent, label) {
  const childPath = path.resolve(child);
  const parentPath = path.resolve(parent);
  const relative = path.relative(parentPath, childPath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return childPath;
  throw new Error(`${label} must stay inside ${parentPath}`);
}

function runNodeScript(script, { root = ROOT } = {}) {
  const scriptPath = path.join(root, script);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function copyFileRequired(from, to) {
  if (!fs.existsSync(from)) throw new Error(`missing required file: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function syncShapeUi({ root = ROOT } = {}) {
  const source = path.join(root, "packages", "shape-ui");
  const target = path.join(root, "apps", "web", "shape-ui");
  const webDir = path.join(root, "apps", "web");
  assertInside(target, webDir, "web shape-ui target");

  if (fs.existsSync(path.join(source, "package.json"))) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
    return "synced-from-package";
  }
  if (fs.existsSync(path.join(target, "package.json"))) {
    return "kept-existing-web-copy";
  }
  throw new Error("missing packages/shape-ui and apps/web/shape-ui; cannot vendor web assets");
}

function vendorWeb({ root = ROOT, runBuilders = true } = {}) {
  if (runBuilders) {
    runNodeScript(path.join("scripts", "build-ics.js"), { root });
    runNodeScript(path.join("scripts", "build-bundles.js"), { root });
  }

  const shapeUiMode = syncShapeUi({ root });
  copyFileRequired(
    path.join(root, "cohort-data", "calendar.json"),
    path.join(root, "apps", "web", "calendar.json"),
  );
  copyFileRequired(
    path.join(root, "cohort-data", "calendar.ics"),
    path.join(root, "apps", "web", "calendar.ics"),
  );
  const webSurface = path.join(root, "apps", "web", "cohort-surface.json");
  if (!fs.existsSync(webSurface)) throw new Error("missing apps/web/cohort-surface.json; build-bundles did not write the public web surface");
  return { ok: true, shapeUiMode, webSurface };
}

function main() {
  const result = vendorWeb();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

export {
  assertInside,
  syncShapeUi,
  vendorWeb,
};
