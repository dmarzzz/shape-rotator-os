-- Adds a customizable BACKGROUND colour to per-person spheres.
--
-- Additive follow-up to 20260618010000_os_spheres.sql. `bg` is a hex colour
-- (#rrggbb) shown behind the sphere everywhere it renders (avatar, editor
-- preview, cohort cards, detail page). NULL = transparent (the original
-- floating look), so existing rows are unaffected.
--
-- Like the base table this must be HAND-APPLIED to project txjntzwksiluvqcpccpc
-- (dashboard SQL editor or `supabase db push`). Until applied, the bg column is
-- absent: reads simply omit it and saves that include `bg` fail — so apply this
-- before relying on background colours.

alter table public.os_spheres
  add column if not exists bg text
    check (bg is null or bg ~ '^#[0-9a-fA-F]{6}$');

-- Extend the existing column-scoped anon write grants to include bg (grants are
-- additive per column; the SELECT grant already covers the new column).
grant insert (bg) on public.os_spheres to anon;
grant update (bg) on public.os_spheres to anon;
