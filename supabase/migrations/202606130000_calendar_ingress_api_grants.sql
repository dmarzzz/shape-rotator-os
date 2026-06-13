-- Let PostgREST and Edge Functions use the RLS-protected calendar ingress
-- schema. RLS still decides row access for authenticated users; service_role is
-- reserved for trusted server-side orchestration.

grant usage on schema public to anon, authenticated, service_role;

revoke all privileges on table
  public.orgs,
  public.org_memberships,
  public.calendar_connections,
  public.calendar_acl_bindings,
  public.routing_policies,
  public.sessions,
  public.session_attendees,
  public.event_requests,
  public.calendar_sync_state,
  public.ingestion_events,
  public.capture_artifacts,
  public.source_artifacts,
  public.processing_jobs,
  public.derived_artifacts,
  public.artifact_reviews,
  public.approval_gates,
  public.audit_log
from anon;

grant select on table
  public.orgs,
  public.org_memberships,
  public.calendar_connections,
  public.calendar_acl_bindings,
  public.routing_policies,
  public.sessions,
  public.session_attendees,
  public.event_requests,
  public.calendar_sync_state,
  public.ingestion_events,
  public.capture_artifacts,
  public.source_artifacts,
  public.processing_jobs,
  public.derived_artifacts,
  public.artifact_reviews,
  public.approval_gates,
  public.audit_log
to authenticated;

grant insert on table
  public.sessions,
  public.session_attendees,
  public.event_requests,
  public.ingestion_events,
  public.capture_artifacts,
  public.source_artifacts,
  public.processing_jobs,
  public.derived_artifacts,
  public.artifact_reviews,
  public.approval_gates
to authenticated;

grant update on table
  public.org_memberships,
  public.calendar_connections,
  public.calendar_acl_bindings,
  public.routing_policies,
  public.sessions,
  public.session_attendees,
  public.event_requests,
  public.calendar_sync_state,
  public.ingestion_events,
  public.capture_artifacts,
  public.source_artifacts,
  public.processing_jobs,
  public.derived_artifacts,
  public.approval_gates
to authenticated;

grant delete on table
  public.org_memberships,
  public.calendar_connections,
  public.calendar_acl_bindings,
  public.routing_policies,
  public.session_attendees,
  public.calendar_sync_state,
  public.ingestion_events,
  public.capture_artifacts,
  public.processing_jobs,
  public.derived_artifacts,
  public.approval_gates
to authenticated;

grant all privileges on table
  public.orgs,
  public.org_memberships,
  public.calendar_connections,
  public.calendar_acl_bindings,
  public.routing_policies,
  public.sessions,
  public.session_attendees,
  public.event_requests,
  public.calendar_sync_state,
  public.ingestion_events,
  public.capture_artifacts,
  public.source_artifacts,
  public.processing_jobs,
  public.derived_artifacts,
  public.artifact_reviews,
  public.approval_gates,
  public.audit_log
to service_role;

grant execute on function
  public.is_org_member(uuid),
  public.is_org_coordinator(uuid),
  public.is_org_admin(uuid)
to authenticated, service_role;
