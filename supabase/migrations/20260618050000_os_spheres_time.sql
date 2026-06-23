-- Adds the Time dial: a per-person animation-speed multiplier for the orb.
-- Stored as the raw 0..1 slider value (default 0.5 = 1× / the original speed):
-- 0 → frozen, 0.5 → 1×, 1 → 1.5×. The 0..1 → multiplier mapping lives in
-- shape-canvas.js (timeMult), so the column just holds the slider position.
--
-- Additive follow-up to the os_spheres migrations; absent → reads omit it and
-- saveSphere's progressive retry drops it, so everything keeps working until this
-- is hand-applied to project txjntzwksiluvqcpccpc.

alter table public.os_spheres
  add column if not exists time_scale real
    check (time_scale is null or (time_scale >= 0 and time_scale <= 1));

grant insert (time_scale) on public.os_spheres to anon;
grant update (time_scale) on public.os_spheres to anon;
