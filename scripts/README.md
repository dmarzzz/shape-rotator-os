# `scripts/`

Build, sync, and audit tooling for the cohort data + calendar/transcript pipeline.
Most scripts are invoked through `npm run …` targets defined in the repo-root
[`package.json`](../package.json); a few are operator-only (see below).

## Module-system convention

The directory currently mixes module systems. **For new scripts, write ESM (`.mjs`).**

| Extension | Module system | Use for |
|-----------|---------------|---------|
| `.mjs`    | ESM           | **New scripts.** Most of the newer transcript-* tooling. |
| `.js`     | CommonJS      | Older calendar/google scripts (legacy; don't add more). |
| `.cjs`    | CommonJS      | Shared libraries under [`lib/`](./lib) (imported by both). |

Shared helpers in `lib/` are `.cjs`, so ESM scripts that need them bridge with:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { /* … */ } = require("./lib/calendar-integration.cjs");
```

New ESM scripts should parse args with the built-in
[`node:util.parseArgs`](https://nodejs.org/api/util.html#utilparseargsconfig)
(already used by several newer scripts) rather than hand-rolling an `arg()` helper.

## Tests

Co-located `*.test.{js,mjs}` files are run by the repo-root `npm test`, which
discovers them by glob — **a new `*.test.mjs` is picked up automatically**, no
need to register it anywhere. Some web-facing tests import the build-generated
`apps/web/shape-ui/` copy, so run `npm run vendor:web` once before `npm test` in
a fresh checkout.

`scripts/test-model-helpers.mjs` is the one test not matching the `*.test.*`
pattern; it runs via `npm run test:models`.

## Operator-only scripts (no npm/CI wiring)

These are run manually as `node scripts/<name>` and are intentionally not wired
into `package.json` or CI. Listed here for discoverability:

- `build-cohort-timeline.js` — one-off cohort timeline generation.
- `create-google-calendar-event.js` / `prepare-google-calendar-event.js` —
  manual single-event helpers (superseded for bulk flows by the
  `calendar:sync` target).

If any of the above is genuinely obsolete, confirm and delete it; otherwise add
a thin `npm run` alias so it shows up in the script catalog.
