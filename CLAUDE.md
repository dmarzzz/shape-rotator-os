# CLAUDE.md — Shape Rotator OS

## Design system (type · color · buttons · dropdowns)

There is one design system. Use it for all new UI. Do not invent new font sizes,
colors, or button/dropdown styles.

- **Source of truth:** [`apps/os/src/design-system/`](apps/os/src/design-system/)
  (`ds.css` tokens + application layer; see its `README.md`). Built on
  [`vendor/shape-ui/tokens.css`](apps/os/src/vendor/shape-ui/tokens.css).
- **Type:** use the `--ds-text-*` scale (2xs→display, 9 steps) with its matching
  `--ds-lh-*`. Never hard-code a px font-size. Two fonts only: `--ds-font-ui`
  (Space Grotesk), `--ds-font-mono` (JetBrains Mono).
- **Color:** use semantic roles — `--ds-ink-1..4`, `--ds-surface-1..4`,
  `--ds-border` / `--ds-border-strong`, `--ds-accent` / `--ds-accent-hover`,
  `--ds-danger`, `--ds-focus`. Never hard-code a hex or `rgb()` in new rules.
- **Buttons:** reuse a button class (or `.btn`) + an intent modifier:
  `.ds-primary`, `.ds-danger`, `.ds-icon-btn`, `.ds-ghost`. One geometry
  (`--ds-control-h`), one focus ring.
- **Inputs/dropdowns:** native controls are covered; custom menus use the
  `--ds-*` control tokens and the established `*-menu`/`*-opt` classes.

The system is **always on**: `data-ds="on"` is set permanently on `<html>` in
`index.html`, and the application layer in `ds.css` is scoped under
`html[data-ds]`. (It was rolled out behind an R-key A/B toggle, since removed.)
When you migrate a screen, point its rules at `--ds-*` tokens and drop the
duplicated raw values — don't add a parallel token scale (`--ed-*`, `--ts-*`,
`--t-*` are legacy; alias, don't extend).

Enforcement is by convention (no CI/lint gate) — follow it by default.
