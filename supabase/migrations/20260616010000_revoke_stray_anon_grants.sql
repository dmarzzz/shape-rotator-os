-- Security hygiene: revoke inert TRUNCATE/REFERENCES/TRIGGER grants the anon
-- role held on these two tables. anon never had SELECT on them (so no read
-- leak), and PostgREST never exposes TRUNCATE/REFERENCES/TRIGGER over HTTP, so
-- this was not exploitable via the public API — but it left anon's grant set
-- wider than its intended surface (SELECT on the public_* projections only).
-- Found during the public_calendar_grid security review; applied to project
-- txjntzwksiluvqcpccpc.
do $$
begin
  if to_regclass('public.calendar_event_mirrors') is not null then
    revoke truncate, references, trigger on public.calendar_event_mirrors from anon;
  end if;

  if to_regclass('public.team_standing_weekly') is not null then
    revoke truncate, references, trigger on public.team_standing_weekly from anon;
  end if;
end $$;
