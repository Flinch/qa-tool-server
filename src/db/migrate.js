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

CREATE INDEX IF NOT EXISTS idx_execution_runs_project ON execution_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_test_cases_run ON execution_run_test_cases(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_suites_run ON execution_run_suites(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_bugs_execution_run ON bugs(execution_run_id);
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