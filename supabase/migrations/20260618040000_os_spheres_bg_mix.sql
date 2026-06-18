-- Adds the Orb Core "amount" dial: how strongly the chosen bg colour tints the
-- whole orb (the shader's mix weight). 0 = colour barely shows (kaleidoscope on
-- top), 1 = the orb is fully that colour. NULL = the default 0.45.
--
-- Additive follow-up to the os_spheres migrations; absent → reads omit it and
-- saveSphere's progressive retry drops it, so everything keeps working until this
-- is hand-applied to project txjntzwksiluvqcpccpc.

alter table public.os_spheres
  add column if not exists bg_mix real
    check (bg_mix is null or (bg_mix >= 0 and bg_mix <= 1));

grant insert (bg_mix) on public.os_spheres to anon;
grant update (bg_mix) on public.os_spheres to anon;
