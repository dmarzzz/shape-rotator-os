-- Store Drive/source classification confidence without exposing raw transcript text.
--
-- The source_artifacts table is the durable Supabase anchor for transcript
-- source refs. Confidence values live in metadata so the importer can add
-- type/group/understanding percentages without widening the core relational
-- schema for each classifier revision.

alter table public.source_artifacts
add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists source_artifacts_type_confidence_pct_idx
on public.source_artifacts ((
  case
    when (metadata->>'type_confidence_pct') ~ '^[0-9]+(\.[0-9]+)?$'
      then (metadata->>'type_confidence_pct')::numeric
    else null
  end
))
where metadata ? 'type_confidence_pct';

create index if not exists source_artifacts_group_confidence_pct_idx
on public.source_artifacts ((
  case
    when (metadata->>'group_confidence_pct') ~ '^[0-9]+(\.[0-9]+)?$'
      then (metadata->>'group_confidence_pct')::numeric
    else null
  end
))
where metadata ? 'group_confidence_pct';

create index if not exists source_artifacts_understanding_confidence_pct_idx
on public.source_artifacts ((
  case
    when (metadata->>'understanding_confidence_pct') ~ '^[0-9]+(\.[0-9]+)?$'
      then (metadata->>'understanding_confidence_pct')::numeric
    else null
  end
))
where metadata ? 'understanding_confidence_pct';
