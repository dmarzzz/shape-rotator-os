# PRD — Shape Rotator OS

Succinct log of shipped features. Newest first.

## Loud update-available signal (2026-06-12)

- **Update banner**: when a newer release is detected (silent boot check
  or main's periodic check, now every 2h instead of 6h) a persistent
  "update available!" banner appears in the left side panel, directly
  above the profile/version footer row and matching the panel width. Its
  background "breathes" (slow brightness pulse, reduced-motion aware) to
  draw the eye. Clicking it runs the platform's existing download/install
  action — that is the only way to clear it (no dismiss). Previously the
  only signal was the small icon by the version chip (bottom-left), which
  users missed.
- **Background checks now reach the UI**: main's `update-available` event
  was stderr-only; it's now forwarded over new IPC `fg:update-available`
  ([main.js](apps/os/main.js) → [preload.js](apps/os/preload.js) →
  `announceUpdateAvailable()` in [boot.js](apps/os/src/renderer/boot.js)),
  so week-long sessions learn about releases without anyone clicking.
- **Old-version broadcast**:
  [cohort-data/asks/2026-06-12-update-your-app.md](cohort-data/asks/2026-06-12-update-your-app.md)
  — every install ≥v0.2.10 polling cohort-data renders it on the asks
  wall, nudging users on old builds (which predate the banner) to update.

## Calendar page redesign — one-view timeline (2026-06-11)

Replaced the day/week/presence sub-tabbed calendar with a single
Google-Calendar-shaped week view ([apps/os/src/renderer/calendar.js](apps/os/src/renderer/calendar.js) + `.css`):

- **Layout**: days as columns left→right (mon–sun), vertical hour axis,
  events as time-positioned blocks; overlapping events split side-by-side.
- **Never looks sparse**: the hour window hugs the week's actual content,
  runs of 2+ event-free hours collapse into thin hatched "open" bands
  (non-linear time axis), active hours stretch to fill the viewport, and
  unscheduled regions of each day are tiled with quiet "open" blocks.
- **Cards adapt to rendered size** (container queries): sliver = one line,
  tall = full title + detail bullets inline, no click needed; click opens
  a detail modal.
- **Robust time parsing** for the sheet's formats: `19:00 x`,
  `12:00-14:00 x`, `- 1600-1730 x`, `1600 - 1830: x`, `09:00am: x`;
  bare-time first lines promote the next line to the title.
- **Multi-day text events** (`Mon-Tue: …` in the first day's cell) mirror
  onto every covered day; day-name prefixes stripped from titles.
- **All-day lane** for untimed items, category-tinted chips.
- **Presence** (availability gantt) is a second tab on the page, using the
  shared `.alch-page-views` nav; gantt vertical scrolling fixed.
- **Navigation**: one centered strip `← 1 2 … 10 →`; today's week dot has
  a white outline, the viewed week fills oxide. Today is highlighted by
  white contrast only (no badge, no red).
- **Unified chrome**: shared view-nav tabs, standard canvas gutters across
  all pages (asks/cohort de-centered, cohort's narrowed padding removed),
  presence-head buttons share one pill style.
- Legacy renderer (`cohort-calendar-week.js` renderWeekView) remains in
  `packages/shape-ui` for the sibling web app; the Electron page no longer
  uses it. Saved `calendar2` modes/tabs migrate to `calendar`.
