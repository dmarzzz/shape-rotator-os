-- Adds an optional user-authored shader EXPRESSION to per-person spheres.
--
-- Additive follow-up to the os_spheres migrations. `shader_src` is a short text
-- expression in a restricted mini-language (see apps/os/src/renderer/shader-dsl.mjs),
-- NOT raw GLSL. NULL = use the dials.
--
-- SECURITY: this column stores UNTRUSTED text — the shipped anon key can POST any
-- string here, bypassing the editor. It is NEVER trusted at face value: every
-- viewer re-parses + allowlist-validates + re-emits it (shader-dsl.compileUserExpr)
-- before it ever reaches a GL compiler, and any failure falls back to the standard
-- shader. The single-expression DSL has no loops/statements and a node-count cap,
-- so it cannot hang the GPU. The length CHECK below is defense-in-depth against
-- oversized direct writes; the real validation is client-side on read.
--
-- Hand-apply to project txjntzwksiluvqcpccpc (dashboard SQL editor / `supabase db
-- push`). Until applied, the column is absent: reads omit it and saveSphere's
-- progressive retry drops it, so the dials keep working.

alter table public.os_spheres
  add column if not exists shader_src text
    check (shader_src is null or char_length(shader_src) <= 8000);

grant insert (shader_src) on public.os_spheres to anon;
grant update (shader_src) on public.os_spheres to anon;
