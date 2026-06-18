// before-pack-stage-binaries.cjs
//
// electron-builder `beforePack` hook. Fixes #186.
//
// The os-release matrix runs ONE runner per platform, but electron-builder
// cross-builds both arches of each .dmg / .AppImage on that single runner.
// The fetch scripts (scripts/fetch-swf-node.sh, scripts/fetch-research-swarm.sh)
// now stage BOTH arches into:
//
//   apps/os/build-resources/_staging/<name>/<arch>/<binary>
//
// extraResources in package.json copies build-resources/<name>/ →
// Resources/<name>/. beforePack runs once per arch target (inside the
// per-arch pack loop, before extraResources are copied — verified against
// app-builder-lib platformPackager.doPack), so here we flatten the matching
// arch's staged binary into build-resources/<name>/ so each per-arch bundle
// ships the correct binary instead of the runner's host arch.
//
// electron-builder does NOT macro-expand the `from` field of extraResources
// (app-builder-lib fileMatcher), so a ${arch} path in package.json is not an
// option — staging through this hook is the supported seam.
//
// Defensive: if a per-arch staging dir is absent (e.g. local `npm run pack`
// without running the fetch scripts), the flat build-resources/<name>/ dir is
// left as-is so existing local/dev workflows keep working.

const fs = require("node:fs");
const path = require("node:path");

// app-builder-lib Arch enum (packages/builder-util/src/arch.ts) → the arch
// token the fetch scripts use for the staging subdir.
const ARCH_NAME = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

// Single-file binaries fetched per-arch in CI and copied via extraResources.
// "whisper" stages a dir (whisper-cli + ffmpeg + ggml model) for cross-platform
// voice (scripts/fetch-whisper.sh). Like swf-node it degrades gracefully: a
// missing per-arch staging dir leaves build-resources/whisper/ untouched and the
// app falls back to MLX (Apple Silicon) or type-only.
const BUNDLES = ["swf-node", "research-swarm", "whisper"];

module.exports = async function beforePack(context) {
  const archName = ARCH_NAME[context.arch] || String(context.arch);
  const buildResources = path.resolve(__dirname, "..", "build-resources");
  const stagingBase = path.join(buildResources, "_staging");

  // Bake the cohort_app Supabase JWT into the packaged app so every install
  // reads the GATED T2 evidence with no per-user setup. Sourced from the
  // SRFG_COHORT_KEY build env (set on the release runner / locally for a
  // provisioned build); EMPTY when unset → the build ships no key and the app
  // falls back to the public anon T3 read. The file is gitignored: the secret
  // never enters this public repo; this hook is the only place it is written.
  const cohortKeyFile = path.join(buildResources, "cohort-app-key.json");
  const cohortKey = String(process.env.SRFG_COHORT_KEY || "").trim();
  // World-readable (0644): the .deb/AppImage ships this into root-owned /opt
  // resources and the app runs as the unprivileged desktop user, so 0600 makes
  // it unreadable (EACCES → silent T3 fallback). The key is already inside the
  // shipped binary, so 0600 buys no secrecy. writeFileSync's mode is ignored
  // when the file already exists (e.g. a prior local 0600 build), so chmod too.
  fs.writeFileSync(cohortKeyFile, JSON.stringify({ cohortKey }) + "\n", { mode: 0o644 });
  try { fs.chmodSync(cohortKeyFile, 0o644); } catch {}
  console.log(
    `[before-pack] cohort-app-key.json ${cohortKey ? "written (key present)" : "written EMPTY (no SRFG_COHORT_KEY → anon T3 fallback)"}`
  );

  for (const name of BUNDLES) {
    const flatDir = path.join(buildResources, name);
    // Ensure the extraResources `from` dir always exists (may end up empty,
    // e.g. windows-arm64 where there is no upstream asset — same degraded
    // behavior as before this fix).
    fs.mkdirSync(flatDir, { recursive: true });

    const archDir = path.join(stagingBase, name, archName);
    if (!fs.existsSync(archDir)) {
      console.log(
        `[before-pack] ${name}: no staged binary for ${archName} — leaving build-resources/${name}/ untouched`
      );
      continue;
    }

    // Clear stale top-level files left by the previous arch in this same job
    // (arches pack sequentially), then copy this arch's staged files up.
    for (const entry of fs.readdirSync(flatDir, { withFileTypes: true })) {
      if (entry.isFile()) fs.rmSync(path.join(flatDir, entry.name), { force: true });
    }

    let copied = 0;
    for (const entry of fs.readdirSync(archDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const dest = path.join(flatDir, entry.name);
      fs.copyFileSync(path.join(archDir, entry.name), dest);
      try {
        fs.chmodSync(dest, 0o755);
      } catch {
        /* best-effort exec bit; non-fatal on Windows */
      }
      copied += 1;
    }
    console.log(
      `[before-pack] ${name}: staged ${copied} file(s) for ${archName} (${context.electronPlatformName})`
    );
  }
};
