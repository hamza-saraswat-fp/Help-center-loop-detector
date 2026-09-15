-- IAI-660 - Help Center Gap Detector: the loop database.
--
-- Six tables, applied once into the loop's own Supabase project. This is the
-- only database the service writes to; every upstream source is read through
-- its `hc_gap_events_v` view and is never written to.
--
-- WHY each table:
--   prompts              the gap-check prompt, versioned, edited without a
--                        redeploy. Mirrors Juju's prompts table so the same
--                        admin app can manage it. The loop is READ-ONLY here.
--   gap_events           one row per tool-detected event, deduped on
--                        (source, source_event_id) so the 14-day re-pull is an
--                        upsert rather than a duplicate.
--   gap_candidates       one row per gap, which is what a Slack card shows.
--                        `id` is the "candidate #N" printed on cards and PRs.
--   gap_candidate_events which events rolled up into which candidate.
--   gap_actions          the audit trail, and the idempotency guard: the two
--                        partial unique indexes are what stop a re-run from
--                        posting a second card or opening a second PR.
--   loop_runs            the run ledger: one row per non-dry_run run.
--
-- The SQL is the plan's Data model section, expanded onto one column per line.
-- Never renumber this file once it has been applied.

create table prompts (
  id            uuid primary key default gen_random_uuid(),
  slot_id       text not null,
  -- TEXT on purpose. '1.10.0' sorts after '1.9.0' to a human and before it to
  -- a string comparison, and neither is a number. Never coerce it.
  version       text not null,
  prompt_text   text not null,
  model         text not null,
  description   text not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  created_by    text,

  unique (slot_id, version)
);

create unique index prompts_one_active_per_slot
  on prompts (slot_id)
  where is_active;

-- Save: demote the current active row, insert a new active one. Atomic.
create or replace function save_prompt_version(
  p_slot_id     text,
  p_version     text,
  p_prompt_text text,
  p_model       text,
  p_description text
) returns uuid
language plpgsql
as $$
declare
  v_new_id uuid;
begin
  update prompts
    set is_active = false
    where slot_id = p_slot_id and is_active;

  insert into prompts (slot_id, version, prompt_text, model, description, is_active)
  values (p_slot_id, p_version, p_prompt_text, p_model, p_description, true)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

create table gap_events (
  id                bigserial primary key,
  source            text not null check (source in ('juju', 'sidecar', 'ava', 'email')),
  source_event_id   text not null,
  kind              text,
  occurred_at       timestamptz not null,
  question          text not null,
  truth_answer      text,
  truth_kind        text not null default 'none'
                      check (truth_kind in ('human', 'onyx_verified', 'onyx_confluence', 'ai_verdict', 'none')),
  cited_hc_urls     jsonb not null default '[]'::jsonb,
  closest_article_url text,
  category          text,
  source_link       text,
  pinged_at         timestamptz,
  needs_answer      boolean not null default false,
  detail            jsonb not null default '{}'::jsonb,
  pulled_at         timestamptz not null default now(),
  processed_at      timestamptz,
  outcome           text check (outcome in ('candidate', 'duplicate', 'shortcut_none', 'held', 'check_failed')),
  candidate_id      bigint,

  unique (source, source_event_id)
);

create index gap_events_unprocessed_idx
  on gap_events (occurred_at)
  where processed_at is null;

create table gap_candidates (
  id                  bigserial primary key,
  fingerprint         text not null unique,
  fingerprint_terms   text[] not null default '{}',
  category            text,
  destination         text not null check (destination in ('help_center', 'internal', 'none')),
  verdict             text check (verdict in ('INCORRECT', 'MISSING', 'NEEDS_EDIT', 'UNFINDABLE', 'HIDDEN', 'NOT_A_GAP')),
  priority            text check (priority in ('P1', 'P2', 'P3')),
  truth_kind          text not null default 'none',
  needs_answer        boolean not null default false,
  -- Model-written. No PII reaches this table: see Global Constraints.
  question_paraphrase text not null,
  truth_summary       text,
  target_article_path text,
  target_article_url  text,
  says_now            text,
  should_say          text,
  proposed_change     text,
  paste_request       text,
  confidence          smallint check (confidence between 0 and 100),
  evidence            jsonb not null default '{}'::jsonb,
  status              text not null default 'new'
                        check (status in ('new', 'held', 'posted', 'adopted', 'rejected', 'pr_open', 'merged', 'logged')),
  check_attempts      smallint not null default 0,
  slack_channel       text,
  slack_ts            text,
  first_seen          timestamptz not null,
  last_seen           timestamptz not null,
  event_count         integer not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index gap_candidates_status_idx
  on gap_candidates (status);

create index gap_candidates_category_seen_idx
  on gap_candidates (category, last_seen desc);

alter table gap_events
  add constraint gap_events_candidate_fk
  foreign key (candidate_id) references gap_candidates(id);

create table gap_candidate_events (
  candidate_id bigint not null references gap_candidates(id),
  event_id     bigint not null references gap_events(id),
  linked_at    timestamptz not null default now(),

  primary key (candidate_id, event_id)
);

create table gap_actions (
  id           bigserial primary key,
  candidate_id bigint not null references gap_candidates(id),
  action       text not null
                 check (action in ('posted', 'thread_reply', 'owner_pinged', 'adopted', 'rejected', 'pr_opened', 'merged', 'recheck_posted')),
  actor        text,
  slack_ts     text,
  pr_url       text,
  article_url  text,
  note         text,
  at           timestamptz not null default now()
);

-- Idempotency, not bookkeeping: a crashed run that re-processes the same
-- candidate cannot post a second card, ping an owner twice, or double-record
-- an adoption. `thread_reply` and `recheck_posted` are deliberately excluded,
-- since those repeat by design.
create unique index gap_actions_once_idx
  on gap_actions (candidate_id, action)
  where action in ('posted', 'owner_pinged', 'adopted', 'rejected', 'merged');

create unique index gap_actions_pr_idx
  on gap_actions (candidate_id, pr_url)
  where action = 'pr_opened';

create table loop_runs (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  mode            text not null check (mode in ('dry_run', 'shadow', 'live', 'calibrate')),
  git_sha         text,
  docs_sha        text,
  events_pulled   integer not null default 0,
  events_by_source jsonb not null default '{}'::jsonb,
  candidates_new  integer not null default 0,
  duplicates      integer not null default 0,
  held            integer not null default 0,
  cards_posted    integer not null default 0,
  checks_failed   integer not null default 0,
  cost_usd        numeric(10,4),
  summary_posted  boolean not null default false,
  errors          jsonb not null default '[]'::jsonb
);

create index loop_runs_started_idx
  on loop_runs (started_at desc);
