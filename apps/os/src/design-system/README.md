# Shape Rotator — Design System

One source of truth for **type · color · buttons · dropdowns**, so screens stop
reinventing these. Built on the existing tokens in
[`vendor/shape-ui/tokens.css`](../vendor/shape-ui/tokens.css) (`--ink-*`, `--red-*`,
`--space-*`, `--r-*`, `--font-*`) — not a competing namespace.

## Files
- [`ds.css`](ds.css) — the `--ds-*` tokens (global) + the application layer.

## How it's wired
The application layer is scoped under `html[data-ds]`, and `data-ds="on"` is set
permanently on `<html>` in `index.html`, so the system is **always on**. (It was
built behind an R-key A/B toggle during rollout; that toggle has been removed now
that the look is approved.) The `!important` in the application layer is a holdover
from that overlay phase — as screens are migrated, those overrides can fold into
source as plain rules and the legacy declarations deleted.

## Using it in NEW code (this is the convention)
**Never hard-code a px font-size or a hex/rgb color in new UI.** Reach for tokens.

### Type — 10 steps (size + line-height travel together)
`--ds-text-2xs`(10) · `xs`(11) · `sm`(12) · `md`(13) · `base`(14) · `lg`(16) ·
`xl`(20) · `2xl`(24) · `display`(28) · `hero`(36), each with a matching `--ds-lh-*`.
`display` is the rail-page hero ("first week"); `hero` is the single biggest
title on a detail/section page (project/team name, calendar week title, program
page title). 10px is the floor — nothing smaller.
```css
.thing { font: var(--ds-weight-med) var(--ds-text-sm)/var(--ds-lh-sm) var(--ds-font-mono); }
```
Two families only: `--ds-font-ui` (Space Grotesk) and `--ds-font-mono` (JetBrains Mono).

### Color — semantic roles, never raw swatches
Ink: `--ds-ink-1/2/3/4`. Surfaces: `--ds-surface-1/2/3/4`. Borders:
`--ds-border`, `--ds-border-strong`. Accent (the one brand color):
`--ds-accent` / `--ds-accent-hover` (+ `--ds-on-accent` for ink on a fill).
States: `--ds-danger`, `--ds-focus`.

### Buttons — one geometry, four intents
Use any existing action-button class, or `.btn`, plus an intent modifier:
- default → outlined neutral
- `.ds-primary` → filled accent
- `.ds-danger` → outlined red
- `.ds-icon-btn` → square, icon-only
- `.ds-ghost` → quiet / borderless

All share `--ds-control-h` (30px), `--ds-radius`, the mono label, and one focus ring.

### Inputs & dropdowns
Native `<input>/<textarea>/<select>` are styled automatically under the system.
Custom dropdown menus are unified end-to-end: the floating panel (one surface +
border + radius + `--ds-shadow-menu`), the option rows, and a single oxide-tint
selected wash (`--ds-accent-soft`, covering `aria-selected`/`aria-checked`/
`.is-active`/`.is-selected`). Covered families: `.c2-scope-*`, `.cw-scope-*`,
`.ac-sent-*`, `.c2-rowsctl-*`, `.cb-intake-intent-*`. New dropdowns should reuse
these tokens. Info popovers (`.anon-popover`, etc.) are tooltips, not dropdowns —
keep them out of the dropdown group.

## Coverage (slice 1)
**Covered:** action + icon buttons, native form controls, custom dropdowns, the
type scale (titles/sections/subs + the legacy `--t-*`/`--ts-*` scales snap to the
system), page heroes (project name / calendar week title / program page title →
`hero`), and the say/did/shipped rows (`.ac-sds-*` 8–9px labels lifted to the 10px
floor).

**Deferred to next slices** (so layouts aren't broken blind):
- segmented/tab controls & the left nav rail (`.alchemy-rail-btn`, `.tab-btn`,
  `.*-scope-btn`, `.*-mode-btn`, `.alch-page-view-btn`, …) — need a dedicated
  "segmented" treatment.
- deep color migration of the ~266 hex / ~757 `rgb()` literals to semantic roles.

## Enforcement
By **convention** (no CI/lint gate): this doc + the rule in the repo `CLAUDE.md`.
New UI uses `--ds-*` tokens and the component classes above.
