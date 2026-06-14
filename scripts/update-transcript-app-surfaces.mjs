#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function hasArg(argv, flag) {
  return argv.includes(flag);
}

function readArg(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status ?? "unknown"}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function summarize() {
  const internalSurface = readJson("apps/os/src/cohort-surface.json");
  const publicSurface = readJson("apps/web/cohort-surface.json");
  const distillations = readJson("cohort-data/artifacts/transcript-distillations/generated/manifest.json");
  const publicArticles = readJson("cohort-data/artifacts/public-transcript-articles/generated/manifest.json");
  return {
    distillation_manifest: {
      artifact_count: distillations.artifact_count,
      cohort_count: distillations.cohort_count,
      public_count: distillations.public_count,
      operator_review_count: distillations.operator_review_count,
    },
    internal_surface: {
      transcript_evidence_sources: internalSurface.transcript_evidence?.source_artifact_count || 0,
      transcript_distillations: internalSurface.transcript_distillations?.artifact_count || 0,
      public_distillations: internalSurface.transcript_distillations?.public_count || 0,
    },
    public_web_surface: {
      visibility: publicSurface.surface_visibility || "unknown",
      transcript_evidence_sources: publicSurface.transcript_evidence?.source_artifact_count || 0,
      transcript_distillations: publicSurface.transcript_distillations?.artifact_count || 0,
      public_distillations: publicSurface.transcript_distillations?.public_count || 0,
    },
    public_article_candidates: {
      article_count: publicArticles.article_count,
      article_mode: publicArticles.article_mode,
      named_entities_allowed: publicArticles.named_entities_allowed,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    console.log([
      "Usage:",
      "  npm run transcripts:app:update -- --env-file .env.calendar.local",
      "",
      "Runs the reviewed transcript distillation export, public no-named article draft generation,",
      "web vendoring, and cohort bundle freshness check.",
    ].join("\n"));
    return;
  }

  const envFile = readArg(argv, "--env-file");
  const exportArgs = envFile ? ["--env-file", envFile] : [];
  runNode(path.join("scripts", "export-transcript-distillations.mjs"), exportArgs);
  runNode(path.join("scripts", "build-public-transcript-articles.mjs"));
  runNode(path.join("scripts", "transcript-surface-leak-scan.mjs"));
  runNode(path.join("scripts", "vendor-web.mjs"));
  runNode(path.join("scripts", "build-bundles.js"), ["--check"]);
  console.log(JSON.stringify({ ok: true, ...summarize() }, null, 2));
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
  main,
  summarize,
};
