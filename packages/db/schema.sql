-- Power Plant Intel — slice 1 schema
-- All tables are public.* unless RLS is explicitly enabled.
-- IDs are bigint identity; external IDs (SEC accession, PUCT control number) are unique strings.

-- ----- 0. Extensions -----
create extension if not exists pgcrypto;
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ----- 1. Source registry (database-driven scout config) -----
create table if not exists source_registry (
  id              bigint generated always as identity primary key,
  source_key      text not null unique,                    -- 'sec_edgar:vistra' etc
  family          text not null,                           -- 'sec_edgar' | 'ercot' | 'puct' | 'tceq' | 'rrc' | 'county'
  display_name    text not null,
  endpoint_url    text not null,
  fetch_method    text not null default 'http_get',         -- 'http_get' | 'browser' | 'rss' | 'api'
  parse_hint      jsonb default '{}'::jsonb,               -- e.g. {"cik":"0001692819","forms":["8-K","10-Q"]}
  poll_minutes    int  not null default 30,
  enabled         boolean not null default true,
  last_polled_at  timestamptz,
  last_ok_at      timestamptz,
  last_error      text,
  consecutive_errors int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists ix_source_registry_enabled on source_registry(enabled, last_polled_at);

-- ----- 2. Raw queue (artifacts the scout captured) -----
create table if not exists raw_queue (
  id              bigint generated always as identity primary key,
  source_id       bigint not null references source_registry(id),
  external_ref    text not null,                            -- e.g. SEC accession 0001144879-26-000036
  url             text not null,
  http_status     int,
  content_hash    text not null,
  bytes           int,
  storage_key     text,                                     -- R2 key once uploaded; null if stored inline
  inline_body     text,                                     -- for small artifacts (< 256KB) keep inline
  meta            jsonb default '{}'::jsonb,                -- form, items, filed_at, etc.
  state           text not null default 'pending',          -- 'pending' | 'ingested' | 'skipped' | 'error'
  state_reason    text,
  fetched_at      timestamptz not null default now(),
  ingested_at     timestamptz,
  unique (source_id, external_ref)
);
create index if not exists ix_raw_queue_state on raw_queue(state, fetched_at);

-- ----- 3. Documents (cleaned text, chunked) -----
create table if not exists documents (
  id              bigint generated always as identity primary key,
  raw_id          bigint not null references raw_queue(id) on delete cascade,
  doc_type        text not null,                            -- 'sec_8k' | 'sec_10q' | 'sec_press' | 'puct_filing' | 'tceq_permit' | 'county_agenda' | 'news' | 'other'
  title           text,
  filed_at        timestamptz,
  page_count      int,
  extraction_method text,                                   -- 'native_html' | 'pdf_text' | 'ocr_vision' | 'rss_summary'
  full_text       text not null,
  full_text_tsv   tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || full_text)) stored,
  ts_inserted     timestamptz not null default now()
);
create index if not exists ix_documents_doc_type on documents(doc_type, filed_at desc);
create index if not exists ix_documents_fts on documents using gin (full_text_tsv);

create table if not exists document_chunks (
  id              bigint generated always as identity primary key,
  document_id     bigint not null references documents(id) on delete cascade,
  idx             int not null,
  text            text not null,
  triage_flag     boolean,                                  -- Haiku triage: relevant?
  triage_reason   text,
  embedding       vector(1536),                             -- nullable until embedded
  unique (document_id, idx)
);
create index if not exists ix_chunks_doc on document_chunks(document_id, idx);

-- ----- 4. Extractions (quote-anchored facts) -----
create table if not exists extractions (
  id              bigint generated always as identity primary key,
  chunk_id        bigint not null references document_chunks(id) on delete cascade,
  document_id     bigint not null references documents(id) on delete cascade,
  kind            text not null,                            -- 'mw' | 'usd' | 'date' | 'party' | 'location' | 'project_name' | 'action'
  value_text      text,                                     -- canonical string
  value_num       numeric,                                  -- canonical number when applicable
  value_unit      text,                                     -- 'MW' | 'USD' | 'GW' | 'mi' | etc.
  source_snippet  text not null,                            -- verbatim quote from chunk text — REQUIRED
  confidence      numeric,                                  -- 0..1 from extractor
  ts_inserted     timestamptz not null default now()
);
create index if not exists ix_extractions_kind on extractions(kind);
create index if not exists ix_extractions_doc on extractions(document_id);

-- ----- 5. Projects (canonical project records) -----
create table if not exists projects (
  id              bigint generated always as identity primary key,
  canonical_name  text not null,
  primary_party   text,                                     -- e.g. "Vistra Corp"
  aliases         text[] not null default '{}',             -- LLC aliases discovered
  county          text,
  state           text not null default 'TX',
  address         text,
  mw_low          numeric,
  mw_high         numeric,
  status          text,                                     -- 'rumored' | 'filed' | 'permitted' | 'under_construction' | 'energized' | 'cancelled'
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  embedding       vector(1536),
  meta            jsonb default '{}'::jsonb
);
create index if not exists ix_projects_county on projects(county);
create index if not exists ix_projects_party on projects using gin (aliases);
-- vector index added later once we have rows + decide HNSW vs IVFFlat
-- create index if not exists ix_projects_emb on projects using hnsw (embedding vector_cosine_ops);

create table if not exists project_signals (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references projects(id) on delete cascade,
  document_id     bigint not null references documents(id) on delete cascade,
  link_reason     text not null,                            -- model-written justification
  link_kind       text not null default 'auto',             -- 'auto' | 'manual' | 'human_review'
  ts_linked       timestamptz not null default now(),
  unique (project_id, document_id)
);
create index if not exists ix_psignals_proj on project_signals(project_id);

-- ----- 6. Change events (typed diffs) -----
create table if not exists change_events (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references projects(id) on delete cascade,
  document_id     bigint not null references documents(id) on delete cascade,
  event_type      text not null,                            -- 'new_project' | 'mw_change' | 'party_change' | 'status_change' | 'date_change' | 'document_added' | 'withdrawal' | 'deposit_event'
  description     text not null,
  before_value    jsonb,
  after_value     jsonb,
  is_substantive  boolean not null,
  ts_event        timestamptz not null default now()
);
create index if not exists ix_change_proj on change_events(project_id, ts_event desc);
create index if not exists ix_change_substantive on change_events(is_substantive, ts_event desc);

-- ----- 7. Signals (scored, audience-tagged events) -----
create table if not exists signals (
  id              bigint generated always as identity primary key,
  change_event_id bigint not null unique references change_events(id) on delete cascade,
  project_id      bigint not null references projects(id) on delete cascade,
  score           int not null check (score between 1 and 10),
  audiences       text[] not null default '{}',             -- {'developer','oem','pe','hedge_fund'}
  urgency         text not null,                            -- 'alert_now' | 'digest_only'
  why_it_matters  text not null,
  rubric_version  text not null,
  ts_scored       timestamptz not null default now()
);
create index if not exists ix_signals_score on signals(score desc, ts_scored desc);
create index if not exists ix_signals_audiences on signals using gin (audiences);

-- ----- 8. QA flags -----
create table if not exists qa_flags (
  id              bigint generated always as identity primary key,
  target_table    text not null,                            -- 'extractions' | 'signals' | 'briefings'
  target_id       bigint not null,
  passed          boolean not null,
  issues          jsonb,                                    -- list of issue objects
  qa_model        text not null,                            -- e.g. 'gemini-2.5-flash'
  ts_qa           timestamptz not null default now()
);
create index if not exists ix_qa_target on qa_flags(target_table, target_id);
create index if not exists ix_qa_failed on qa_flags(passed) where passed = false;

-- ----- 9. Briefings -----
create table if not exists briefings (
  id              bigint generated always as identity primary key,
  week_of         date not null unique,                     -- Monday of the week
  draft_md        text not null,
  source_signal_ids bigint[] not null default '{}',
  qa_passed       boolean not null default false,
  published_at    timestamptz,
  ts_drafted      timestamptz not null default now()
);

-- ----- 10. Subscribers + tiers (slice 1: skeleton) -----
create table if not exists subscribers (
  id              bigint generated always as identity primary key,
  email           text not null unique,
  tier            text not null default 'free',             -- 'free' | 'pro' | 'team' | 'enterprise'
  audiences       text[] not null default '{}',
  stripe_customer_id text,
  ts_signup       timestamptz not null default now()
);

-- ----- 11. Watchdog log -----
create table if not exists scout_runs (
  id              bigint generated always as identity primary key,
  source_id       bigint not null references source_registry(id),
  ran_at          timestamptz not null default now(),
  duration_ms     int,
  http_status     int,
  items_new       int not null default 0,
  items_skipped   int not null default 0,
  ok              boolean not null,
  error           text
);
create index if not exists ix_scout_runs_source on scout_runs(source_id, ran_at desc);

-- ----- 12. Cost ledger (track Anthropic spend per agent) -----
create table if not exists cost_ledger (
  id              bigint generated always as identity primary key,
  ts              timestamptz not null default now(),
  agent           text not null,                            -- 'extraction' | 'triage' | 'tracking' | 'scoring' | 'editorial' | 'outreach' | 'qa' | 'ingestion'
  model           text not null,
  input_tokens    int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  output_tokens   int not null default 0,
  usd_cost        numeric(10,5) not null default 0,
  request_id      text
);
create index if not exists ix_cost_ledger_ts on cost_ledger(ts desc);
create index if not exists ix_cost_ledger_agent on cost_ledger(agent, ts desc);
