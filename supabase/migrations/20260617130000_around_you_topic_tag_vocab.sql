-- Around You feed — controlled topic-tag vocab + validator.
--
-- Backs the "around you" feed's topic routing (see docs/AROUND_YOU_FEED.md +
-- docs/AROUND_YOU_TAGGING_SPEC.md). Published artifacts (transcript-evidence
-- cards, insight cards, articles) carry a controlled `topic_tags` array drawn
-- from this vocab so the feed can bias them toward a viewer's team BY TOPIC,
-- never by identity. This migration adds only the reference vocab + validator;
-- per-source `topic_tags` storage + the public-view projection land separately.
--
-- The vocab mirrors cohort-data/schema.yml `cohort_vocab.skill_areas`
-- (the same set teams declare and buildCollabModel/convergence rank on).
-- Keep the two in sync on vocab edits.

create table if not exists public.cohort_skill_vocab (
  term     text primary key,
  category text not null
);

insert into public.cohort_skill_vocab(term, category) values
  ('tee','confidentiality'),('dstack','confidentiality'),('attestation','confidentiality'),('formal-verification','confidentiality'),
  ('zk','cryptography'),('post-quantum','cryptography'),('threshold-crypto','cryptography'),('mpc','cryptography'),
  ('agentic','agentic'),('agent-runtime','agentic'),('agent-routing','agentic'),
  ('mev','crypto-chain'),('cross-chain','crypto-chain'),('identity','crypto-chain'),
  ('p2p','infra'),('durable-workflows','infra'),('confidential-db','infra'),
  ('design','adjacent'),('bd-gtm','adjacent'),('research-to-product','adjacent'),('generative-media','adjacent'),('mechanism-design','adjacent')
on conflict (term) do nothing;

-- Reference vocab is non-sensitive (already public in schema.yml); anon-readable.
alter table public.cohort_skill_vocab enable row level security;
drop policy if exists cohort_skill_vocab_read on public.cohort_skill_vocab;
create policy cohort_skill_vocab_read on public.cohort_skill_vocab for select using (true);

-- Validator: every element of a topic_tags array must be a known vocab term
-- OR a category parent (categories are used when a sparse leaf is rolled up).
create or replace function public.is_controlled_topic_tags(tags jsonb)
returns boolean language sql immutable set search_path to 'public' as $$
  select tags is null or (
    jsonb_typeof(tags) = 'array' and not exists (
      select 1 from jsonb_array_elements_text(tags) as elem
      where elem not in (select term from public.cohort_skill_vocab)
        and elem not in (select distinct category from public.cohort_skill_vocab)
    )
  )
$$;
