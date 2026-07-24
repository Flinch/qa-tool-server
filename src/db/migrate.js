import { pool } from './pool.js'

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'qa_engineer',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Safe to re-run: adds the new auth columns if this table already existed
-- from before real auth was wired up.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;

CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  client_name  TEXT,
  description  TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT DEFAULT 'viewer',
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS test_cases (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('functional','integration','e2e')),
  steps        JSONB DEFAULT '[]',
  expected     TEXT,
  status       TEXT NOT NULL DEFAULT 'not_run' CHECK (status IN ('not_run','pass','fail')),
  created_by   TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bugs (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  test_case_id        INTEGER REFERENCES test_cases(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  severity            TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical','high','medium','low')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved')),
  steps_to_reproduce  TEXT,
  expected            TEXT,
  actual              TEXT,
  notes               TEXT,
  created_by          TEXT REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Flags whether a test case is a good candidate for test automation (set by
-- the AI at generation time, editable by a QA engineer afterwards). Used to
-- filter down to a worklist when building out automated_test_cases later.
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS automation_candidate BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS automation_reasoning TEXT;

CREATE INDEX IF NOT EXISTS idx_test_cases_project ON test_cases(project_id);
CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id);
CREATE INDEX IF NOT EXISTS idx_bugs_test_case ON bugs(test_case_id);

-- Automation suite hub: buckets of automated tests (regression, smoke, e2e),
-- their execution runs (manual click or nightly cron), and per-test results
-- within each run. Separate from test_cases/bugs above, which are manual QA.

CREATE TABLE IF NOT EXISTS automation_suites (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, slug)
);

CREATE TABLE IF NOT EXISTS automated_test_cases (
  id           SERIAL PRIMARY KEY,
  suite_id     INTEGER REFERENCES automation_suites(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  file_path    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  suite_id       INTEGER REFERENCES automation_suites(id) ON DELETE CASCADE,
  correlation_id TEXT UNIQUE,
  trigger_type   TEXT NOT NULL CHECK (trigger_type IN ('manual','nightly')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed')),
  total          INTEGER,
  passed         INTEGER,
  failed         INTEGER,
  skipped        INTEGER,
  duration_ms    INTEGER,
  report_url     TEXT,
  github_run_url TEXT,
  created_by     TEXT REFERENCES users(id),
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

-- Why a run is sitting at 'failed' — dispatch errors, a CI crash before results
-- were produced, or a server-side timeout when CI never reports back at all.
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE TABLE IF NOT EXISTS test_run_results (
  id            SERIAL PRIMARY KEY,
  test_run_id   INTEGER REFERENCES test_runs(id) ON DELETE CASCADE,
  test_title    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('passed','failed','skipped')),
  duration_ms   INTEGER,
  error_message TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automated_test_cases_suite_title_unique'
  ) THEN
    ALTER TABLE automated_test_cases
      ADD CONSTRAINT automated_test_cases_suite_title_unique UNIQUE (suite_id, title);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_automation_suites_project ON automation_suites(project_id);
CREATE INDEX IF NOT EXISTS idx_automated_test_cases_suite ON automated_test_cases(suite_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_project ON test_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_suite ON test_runs(suite_id);
CREATE INDEX IF NOT EXISTS idx_test_run_results_run ON test_run_results(test_run_id);

-- Execution runs: a QA engineer bundles a selection of manual test_cases and
-- automation_suites into one session, works through the manual cases (pass/fail
-- snapshot independent of test_cases.status), triggers automation suites from
-- inside the run, and ends with a downloadable report.

CREATE TABLE IF NOT EXISTS execution_runs (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed')),
  created_by   TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS execution_run_test_cases (
  id               SERIAL PRIMARY KEY,
  execution_run_id INTEGER REFERENCES execution_runs(id) ON DELETE CASCADE,
  test_case_id     INTEGER REFERENCES test_cases(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'not_run' CHECK (status IN ('not_run','pass','fail','blocked')),
  notes            TEXT,
  executed_by      TEXT REFERENCES users(id),
  executed_at      TIMESTAMPTZ,
  UNIQUE(execution_run_id, test_case_id)
);

-- Fix-up for databases where execution_run_test_cases already exists with the
-- older 'skipped' status option — rename it to 'blocked' and update the check.
UPDATE execution_run_test_cases SET status='blocked' WHERE status='skipped';
ALTER TABLE execution_run_test_cases DROP CONSTRAINT IF EXISTS execution_run_test_cases_status_check;
ALTER TABLE execution_run_test_cases ADD CONSTRAINT execution_run_test_cases_status_check CHECK (status IN ('not_run','pass','fail','blocked'));

CREATE TABLE IF NOT EXISTS execution_run_suites (
  id                 SERIAL PRIMARY KEY,
  execution_run_id   INTEGER REFERENCES execution_runs(id) ON DELETE CASCADE,
  suite_id           INTEGER REFERENCES automation_suites(id) ON DELETE CASCADE,
  latest_test_run_id INTEGER REFERENCES test_runs(id) ON DELETE SET NULL,
  UNIQUE(execution_run_id, suite_id)
);

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS execution_run_id INTEGER REFERENCES execution_runs(id) ON DELETE SET NULL;

-- JIRA cross-post (optional, best-effort — see jiraClient.js and DECISIONS.md).
-- jira_organization is stored for reference only; not yet linked to a real
-- JIRA org via the API (see DECISIONS.md for why that was cut from v1).
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS jira_issue_key TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS jira_issue_url TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS jira_organization TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_runs_project ON execution_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_test_cases_run ON execution_run_test_cases(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_suites_run ON execution_run_suites(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_bugs_execution_run ON bugs(execution_run_id);

-- Comment thread on a bug, visible to every project member (staff + client).
-- image_data holds a base64 data URL — no object storage is configured for
-- this app, so images ride along in the same row as the comment text.
CREATE TABLE IF NOT EXISTS bug_comments (
  id           SERIAL PRIMARY KEY,
  bug_id       INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id),
  body         TEXT,
  image_data   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CHECK (body IS NOT NULL OR image_data IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bug_comments_bug ON bug_comments(bug_id);

-- ============================================================================
-- Test generation pipeline (manual TCs -> Playwright agents -> PR)
-- ============================================================================

-- One row per "Generate automated tests" click. Deliberately SEPARATE from
-- test_runs: a generation run is long (15-30+ min vs minutes), progresses
-- through visible internal phases the UI displays live, and its artifact is a
-- pull request rather than a pass/fail report. Modeling both lifecycles in one
-- table would mean half-null columns and special-cased CHECK constraints.
-- It also must NOT be touched by reconcileStaleRuns and its 10-minute
-- timeout — generation gets its own sweep with a 60-minute window (workflow
-- timeout is 45 min; the sweep must outlast it or a slow-but-succeeding run
-- gets marked failed right before its completion webhook lands).
CREATE TABLE IF NOT EXISTS generation_runs (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  suite_id       INTEGER REFERENCES automation_suites(id) ON DELETE CASCADE,

  -- The handshake between server and CI — two systems with no shared
  -- transaction. Server inserts this row BEFORE dispatching (so a failed
  -- dispatch has somewhere to record its error), CI carries the id through
  -- the whole run, and every webhook event locates the row by it. UNIQUE is
  -- what makes webhook handling idempotent: a retried delivery can't create
  -- a duplicate row.
  correlation_id TEXT UNIQUE,

  -- Lifecycle and phase collapsed into one column on purpose: the phases are
  -- strictly ordered and exactly one is ever true, so a separate phase column
  -- would just be a second thing to keep in sync. CI's generation-events
  -- webhook advances this as the agent script moves through its phases.
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','exploring','generating','healing','opening_pr','completed','failed')),

  -- v1 trade-off, chosen knowingly: an int array instead of a join table.
  -- Costs: no FK integrity on the ids (a deleted TC can leave a dangling id
  -- here), and "which runs included TC-42" needs ANY() scans. Acceptable
  -- because per-TC outcomes live elsewhere (the PR body during review,
  -- automated_test_cases.test_case_id after merge). If Phase 4 wants live
  -- per-TC progress, upgrade path is a generation_run_test_cases join table.
  test_case_ids  INTEGER[] NOT NULL DEFAULT '{}',

  -- Outputs (populated by CI webhook events as they happen)
  branch_name    TEXT,
  pr_url         TEXT,

  -- Populated by the final failure webhook, a failed dispatch, or the sweep.
  error_message  TEXT,

  created_by     TEXT REFERENCES users(id),
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generation_runs_project ON generation_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_generation_runs_suite ON generation_runs(suite_id);

-- automated_test_cases learns where each automated test came from and what
-- review state it's in. Every generated test title starts with "TC-<id>:",
-- which is how report-results.js will link rows here back to manual TCs.

-- SET NULL, not CASCADE: deleting a manual test case must not delete the
-- automated test — that spec still exists in the repo and still runs in CI.
-- The link is metadata about origin, not a lifecycle dependency. (Contrast
-- with suite_id above, which IS lifecycle: no suite, no roster entry.)
ALTER TABLE automated_test_cases ADD COLUMN IF NOT EXISTS
  test_case_id INTEGER REFERENCES test_cases(id) ON DELETE SET NULL;

-- 'manual' default grandfathers every pre-existing row correctly: everything
-- in the roster today was hand-written.
ALTER TABLE automated_test_cases ADD COLUMN IF NOT EXISTS
  origin TEXT NOT NULL DEFAULT 'manual';

-- Review lifecycle for agent-touched tests:
--   active                 normal, trusted
--   pending_review         generated, PR not yet merged/approved
--   healed_pending_review  healer changed it, awaiting human approval (Phase 4)
--   flagged_regression     healer says behavior changed — possible real bug (Phase 4)
ALTER TABLE automated_test_cases ADD COLUMN IF NOT EXISTS
  review_status TEXT NOT NULL DEFAULT 'active';

-- CHECK constraints for the two new columns, added idempotently via the same
-- pg_constraint pattern used for automated_test_cases_suite_title_unique.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automated_test_cases_origin_check'
  ) THEN
    ALTER TABLE automated_test_cases
      ADD CONSTRAINT automated_test_cases_origin_check
      CHECK (origin IN ('manual','generated'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'automated_test_cases_review_status_check'
  ) THEN
    ALTER TABLE automated_test_cases
      ADD CONSTRAINT automated_test_cases_review_status_check
      CHECK (review_status IN ('active','pending_review','healed_pending_review','flagged_regression'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_automated_test_cases_test_case ON automated_test_cases(test_case_id);

-- ============================================================================
-- Requirements traceability (Phase 1: manual only — see DECISIONS.md)
-- ============================================================================

CREATE TABLE IF NOT EXISTS requirements (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_by   TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Pure join table — CASCADE on both sides is safe here (unlike test_cases
-- deletion elsewhere, dropping a link destroys nothing but the link itself).
CREATE TABLE IF NOT EXISTS requirement_test_cases (
  id             SERIAL PRIMARY KEY,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  test_case_id   INTEGER REFERENCES test_cases(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(requirement_id, test_case_id)
);

CREATE INDEX IF NOT EXISTS idx_requirements_project ON requirements(project_id);
CREATE INDEX IF NOT EXISTS idx_requirement_test_cases_requirement ON requirement_test_cases(requirement_id);
CREATE INDEX IF NOT EXISTS idx_requirement_test_cases_test_case ON requirement_test_cases(test_case_id);

-- ============================================================================
-- Requirements traceability (Phase 2: document upload + AI parsing)
-- ============================================================================

-- The uploaded doc, kept permanently as the source-of-truth artifact even
-- after its parsed requirements are edited or superseded by a later upload
-- (diffing against a later upload is Phase 3, not built yet).
CREATE TABLE IF NOT EXISTS requirement_documents (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  filename     TEXT,
  raw_text     TEXT NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requirement_documents_project ON requirement_documents(project_id);

-- SET NULL, not CASCADE: deleting the source document must not delete the
-- requirements parsed from it — same reasoning as
-- automated_test_cases.test_case_id above (origin metadata, not a lifecycle
-- dependency).
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS
  document_id INTEGER REFERENCES requirement_documents(id) ON DELETE SET NULL;

-- Mobile test automation (Phase 6, see DECISIONS.md). Additive: existing
-- suites default to 'web' with no engine set, so nothing already in
-- automation_suites changes meaning. 'engine' is nullable — a 'web' suite
-- has always implicitly meant Playwright and doesn't need it stated.
ALTER TABLE automation_suites ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web'
  CHECK (platform IN ('web','ios','android'));
ALTER TABLE automation_suites ADD COLUMN IF NOT EXISTS engine TEXT
  CHECK (engine IN ('playwright','maestro','appium'));

-- Auto-filed bugs from failed automated test runs (web or mobile — both post
-- through the same POST /webhooks/test-runs contract). 'origin' distinguishes
-- these from hand-logged bugs in the UI; created_by stays NULL for them since
-- there's no user in the loop. SET NULL on both FKs, same reasoning as
-- execution_run_id/test_case_id above: these are provenance, not a lifecycle
-- dependency — deleting a suite or run shouldn't delete the bug it found.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual','automated'));
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS suite_id INTEGER REFERENCES automation_suites(id) ON DELETE SET NULL;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS test_run_id INTEGER REFERENCES test_runs(id) ON DELETE SET NULL;
ALTER TABLE bugs ALTER COLUMN created_by DROP NOT NULL;
-- Failure screenshot captured at the moment of failure (Maestro auto-saves
-- one per failed flow; Playwright's screenshot:'only-on-failure' does the
-- same) — base64 data URL, same format bug_comments.image_data already uses.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS screenshot_data TEXT;

CREATE INDEX IF NOT EXISTS idx_bugs_suite ON bugs(suite_id);
CREATE INDEX IF NOT EXISTS idx_bugs_test_run ON bugs(test_run_id);

-- Distinguishes an automated bug caused by infra/tooling (device unreachable,
-- app not installed, connection refused — the test never really ran) from a
-- genuine assertion failure. Set by classifyFailure.js at bug-creation time
-- from the raw CI error message; always false for manual bugs, which have no
-- such message to classify.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS is_environmental BOOLEAN NOT NULL DEFAULT false;
`

async function migrate() {
  console.log('Running migrations...')
  await pool.query(schema)
  console.log('Migrations complete.')
  await pool.end()
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})