-- Shape OS Matrix sign-in roster.
--
-- Many cohort members have a Matrix account but no recorded email, so the
-- Google-only app_members roster can never cover them. This table is the
-- Matrix-identity mirror of app_members: a matrix_id to cohort-record binding
-- with the same status/role vocabulary. The desktop app verifies control of
-- the Matrix account itself (real OAuth against the homeserver in main.js);
-- this table only answers "is that verified account on the roster, and who
-- is it?".
--
-- Lookup happens through a security-definer function rather than RLS-on-JWT
-- because Matrix sign-in produces no Supabase JWT. That makes membership
-- probeable by matrix_id with the anon key -- an accepted Phase-1 trade-off
-- (the roster itself is public in the app), and it grants NOTHING beyond the
-- front door: the gated T2 views key on auth.jwt() email / cohort_app role
-- and are unaffected by this table.

create table if not exists public.app_matrix_members (
  matrix_id text primary key,
  record_id text,
  record_type text not null default 'person',
  role text not null default 'member',
  status text not null default 'pending',
  display_name text,
  approved_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_matrix_members_id_shape check (
    matrix_id = lower(btrim(matrix_id))
    and matrix_id like '@%'
    and position(':' in matrix_id) > 2
  ),
  constraint app_matrix_members_record_type_nonempty check (length(btrim(record_type)) > 0),
  constraint app_matrix_members_role_check check (role in ('member', 'admin')),
  constraint app_matrix_members_status_check check (status in ('pending', 'approved', 'rejected'))
);

alter table public.app_matrix_members enable row level security;

revoke all privileges on public.app_matrix_members from anon, authenticated;
grant all privileges on public.app_matrix_members to service_role;

-- Point lookup for the gate. STABLE so PostgREST allows GET /rpc/ calls.
create or replace function public.app_matrix_membership(p_matrix_id text)
returns table (
  matrix_id text,
  record_id text,
  record_type text,
  role text,
  status text,
  display_name text,
  approved_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select m.matrix_id, m.record_id, m.record_type, m.role, m.status,
         m.display_name, m.approved_at
  from public.app_matrix_members m
  where m.matrix_id = lower(btrim(p_matrix_id));
$$;

revoke all on function public.app_matrix_membership(text) from public;
grant execute on function public.app_matrix_membership(text) to anon, authenticated, service_role;
