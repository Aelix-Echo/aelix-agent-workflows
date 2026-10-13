-- Tables used by the Aelix Echo agent workflows. Postgres 13+ (sha256() and EXECUTE FUNCTION).
-- Run once against the database selected in the workflows' Postgres credential.

-- One row per workflow run, whichever way it ended.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                bigserial PRIMARY KEY,
  workflow          text        NOT NULL,           -- e.g. fintech-refund-handler
  business_key      text,                           -- request id, invoice id, ticket id...
  outcome           text        NOT NULL,           -- completed | escalated | documents_requested | ready_for_approval
  route             text        NOT NULL,           -- auto | escalate
  decision          jsonb,                          -- the agent's structured output
  guardrail_reasons jsonb       NOT NULL DEFAULT '[]',
  actions           jsonb       NOT NULL DEFAULT '[]',
  approval          jsonb,                          -- { decision, approver, decided_at } when a named person was asked
  tool_calls        integer     NOT NULL DEFAULT 0,
  model             text,
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  chain_seq         bigint      UNIQUE,             -- position in the hash chain (set by trigger)
  prev_hash         text,                           -- row_hash of the previous row in the chain
  row_hash          text                            -- sha256 over prev_hash and this row's content
);
-- Upgrades from the first schema version.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS approval  jsonb;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS chain_seq bigint UNIQUE;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS row_hash  text;
CREATE INDEX IF NOT EXISTS agent_runs_workflow_created ON agent_runs (workflow, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_business_key ON agent_runs (business_key);

-- Tamper-evident audit log.
-- Every insert is chained to the previous row by hash, inside a lock, so the chain
-- has no gaps or forks. Updates, deletes and truncates are refused. Anyone who
-- edits a row by disabling the triggers breaks the chain, and agent_runs_verify()
-- reports the first row where it breaks. For protection against a database
-- superuser, copy the latest row_hash somewhere they cannot write (for example a
-- daily export to write-once object storage).
CREATE OR REPLACE FUNCTION agent_runs_row_content(r agent_runs) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    r.chain_seq::text, r.workflow, coalesce(r.business_key, ''), r.outcome, r.route,
    coalesce(r.decision::text, ''), r.guardrail_reasons::text, r.actions::text, coalesce(r.approval::text, ''),
    r.tool_calls::text, coalesce(r.model, ''), coalesce(r.n8n_execution_id, ''),
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;

CREATE OR REPLACE FUNCTION agent_runs_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq  bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('agent_runs_chain'));
  SELECT chain_seq, row_hash INTO last_seq, last_hash
    FROM agent_runs WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1;
  NEW.created_at := now();
  NEW.chain_seq  := coalesce(last_seq, 0) + 1;
  NEW.prev_hash  := coalesce(last_hash, 'genesis');
  NEW.row_hash   := encode(sha256(convert_to(NEW.prev_hash || '|' || agent_runs_row_content(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION agent_runs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agent_runs is append-only: % is not allowed', TG_OP;
END $$;

DROP TRIGGER IF EXISTS agent_runs_chain_insert ON agent_runs;
CREATE TRIGGER agent_runs_chain_insert BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_chain();
DROP TRIGGER IF EXISTS agent_runs_no_update_delete ON agent_runs;
CREATE TRIGGER agent_runs_no_update_delete BEFORE UPDATE OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_append_only();
DROP TRIGGER IF EXISTS agent_runs_no_truncate ON agent_runs;
CREATE TRIGGER agent_runs_no_truncate BEFORE TRUNCATE ON agent_runs
  FOR EACH STATEMENT EXECUTE FUNCTION agent_runs_append_only();

-- SELECT * FROM agent_runs_verify();  -> no rows means the chain is intact.
CREATE OR REPLACE FUNCTION agent_runs_verify()
RETURNS TABLE (chain_seq bigint, problem text)
LANGUAGE plpgsql AS $$
DECLARE
  r agent_runs;
  expected_prev text := 'genesis';
  expected_seq  bigint := 1;
BEGIN
  FOR r IN SELECT * FROM agent_runs a WHERE a.chain_seq IS NOT NULL ORDER BY a.chain_seq LOOP
    IF r.chain_seq <> expected_seq THEN
      chain_seq := r.chain_seq; problem := 'gap: expected ' || expected_seq; RETURN NEXT; RETURN;
    END IF;
    IF r.prev_hash <> expected_prev THEN
      chain_seq := r.chain_seq; problem := 'prev_hash does not match the previous row'; RETURN NEXT; RETURN;
    END IF;
    IF r.row_hash <> encode(sha256(convert_to(r.prev_hash || '|' || agent_runs_row_content(r), 'UTF8')), 'hex') THEN
      chain_seq := r.chain_seq; problem := 'row content changed after it was written'; RETURN NEXT; RETURN;
    END IF;
    expected_prev := r.row_hash;
    expected_seq  := r.chain_seq + 1;
  END LOOP;
END $$;

-- The exception queue: everything a person needs to decide, in one row.
CREATE TABLE IF NOT EXISTS agent_exceptions (
  id                bigserial PRIMARY KEY,
  workflow          text        NOT NULL,
  business_key      text,
  team              text        NOT NULL,
  status            text        NOT NULL DEFAULT 'open',   -- open | in_review | resolved
  reasons           jsonb       NOT NULL DEFAULT '[]',     -- why it stopped
  proposed_action   jsonb,                                  -- what the agent proposed
  confidence        numeric,
  questions         jsonb       NOT NULL DEFAULT '[]',     -- what the agent wants a person to answer
  trace             jsonb       NOT NULL DEFAULT '[]',     -- every tool call and observation
  summary           text,
  resolution        text,
  resolved_by       text,
  resolved_at       timestamptz,
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_exceptions_open ON agent_exceptions (team, status, created_at);

-- Healthcare prior-auth worklist. Holds PHI: restrict access accordingly.
CREATE TABLE IF NOT EXISTS pa_worklist (
  id                bigserial PRIMARY KEY,
  request_id        text        NOT NULL UNIQUE,
  queue             text        NOT NULL,   -- ready_for_submission_review | needs_documents | clinical_review | no_pa_required_confirm
  urgency           text        NOT NULL,   -- standard | expedited
  payer_name        text,
  packet            jsonb       NOT NULL DEFAULT '[]',
  missing_items     jsonb       NOT NULL DEFAULT '[]',
  reviewer_summary  text,
  confidence        numeric,
  assigned_to       text,
  status            text        NOT NULL DEFAULT 'open',
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pa_worklist_queue ON pa_worklist (queue, urgency, created_at);

-- Drafts waiting for a named reviewer (draft-for-review agents). Nothing in a draft
-- has been filed, sent or applied; the reviewer edits and signs off outside the agent.
CREATE TABLE IF NOT EXISTS agent_drafts (
  id                bigserial PRIMARY KEY,
  workflow          text        NOT NULL,
  business_key      text,
  reviewer          text        NOT NULL,
  status            text        NOT NULL DEFAULT 'open',   -- open | signed_off | rejected
  summary           text,
  draft             jsonb       NOT NULL,
  review_notes      text,
  reviewed_by       text,
  reviewed_at       timestamptz,
  n8n_execution_id  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_drafts_open ON agent_drafts (reviewer, status, created_at);
