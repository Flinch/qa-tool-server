// Tenant schema: one client's QA data, physically isolated in its own
// database. Identical to the shared schema this app used before Phase A,
// minus `users`/`project_members` (identity + membership now live in the
// control plane, see controlPlaneSchema.js) — so every `*_by`/`user_id`
// column here is a plain TEXT id with no local FK, since there's no `users`
// table in this database to reference. That's a deliberate trade-off: DB-
// level referential integrity on "who did this" is given up in exchange for
// real per-tenant data isolation, and it's a safe one — every request that
// reaches a tenant DB has already been authenticated and access-checked
// against the control plane before a single query runs here (see
// requireTenantAccess).
//
// Applied to every tenant DB via migrateTenant() in migrate.js — this is the
// one place tenant schema SQL is defined.

export const TENANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  client_name  TEXT,
  description  TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_cases (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('functional','integration','e2e')),
  steps        JSONB DEFAULT '[]',
  expected     TEXT,
  status       TEXT NOT NULL DEFAULT 'not_run' CHECK (status IN ('not_run','pass','fail')),
  created_by   TEXT,
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
  created_by          TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

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

-- Whether this suite participates in the server-driven nightly scheduler
-- (Phase A, Part 6). Default true for existing suites to match the old
-- GitHub Actions cron's implicit "smoke suite runs nightly" behavior as
-- closely as possible pre-migration; adjust per suite afterwards.
ALTER TABLE automation_suites ADD COLUMN IF NOT EXISTS nightly_enabled BOOLEAN NOT NULL DEFAULT true;

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
  created_by     TEXT,
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'suite';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'test_runs_scope_check'
  ) THEN
    ALTER TABLE test_runs ADD CONSTRAINT test_runs_scope_check CHECK (scope IN ('suite','test_cases'));
  END IF;
END $$;

ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS target_titles TEXT[];

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
  created_by   TEXT,
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
  executed_by      TEXT,
  executed_at      TIMESTAMPTZ,
  UNIQUE(execution_run_id, test_case_id)
);

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
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS jira_issue_key TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS jira_issue_url TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS jira_organization TEXT;

CREATE INDEX IF NOT EXISTS idx_execution_runs_project ON execution_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_test_cases_run ON execution_run_test_cases(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_execution_run_suites_run ON execution_run_suites(execution_run_id);
CREATE INDEX IF NOT EXISTS idx_bugs_execution_run ON bugs(execution_run_id);

-- Comment thread on a bug, visible to every project member (staff + client).
CREATE TABLE IF NOT EXISTS bug_comments (
  id           SERIAL PRIMARY KEY,
  bug_id       INTEGER REFERENCES bugs(id) ON DELETE CASCADE,
  user_id      TEXT,
  body         TEXT,
  image_data   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  CHECK (body IS NOT NULL OR image_data IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_bug_comments_bug ON bug_comments(bug_id);

-- ============================================================================
-- Test generation pipeline (manual TCs -> Playwright agents -> PR)
-- ============================================================================

CREATE TABLE IF NOT EXISTS generation_runs (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  suite_id       INTEGER REFERENCES automation_suites(id) ON DELETE CASCADE,
  correlation_id TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                   ('pending','exploring','generating','healing','opening_pr','completed','failed')),
  test_case_ids  INTEGER[] NOT NULL DEFAULT '{}',
  branch_name    TEXT,
  pr_url         TEXT,
  error_message  TEXT,
  created_by     TEXT,
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_generation_runs_project ON generation_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_generation_runs_suite ON generation_runs(suite_id);

ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generate';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'generation_runs_kind_check'
  ) THEN
    ALTER TABLE generation_runs ADD CONSTRAINT generation_runs_kind_check CHECK (kind IN ('generate','heal'));
  END IF;
END $$;

ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS target_title TEXT;

ALTER TABLE automated_test_cases ADD COLUMN IF NOT EXISTS
  test_case_id INTEGER REFERENCES test_cases(id) ON DELETE SET NULL;

ALTER TABLE automated_test_cases ADD COLUMN IF NOT EXISTS
  origin TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE automated_test_cases ADD COLUMN IF NOT EXISTS
  review_status TEXT NOT NULL DEFAULT 'active';

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
-- Requirements traceability
-- ============================================================================

CREATE TABLE IF NOT EXISTS requirements (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

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

-- Tracks which requirements a critical E2E flow spans (see
-- generateCriticalFlows.js) — deliberately its OWN table, not a reuse of
-- requirement_test_cases. That table backs the regular per-requirement
-- generation/coverage tracking (linked_test_case_count, the "uncovered
-- requirements" query "Generate all test cases" relies on). A flow linking
-- into it made a requirement look "covered" the moment any flow happened to
-- touch it, even with zero dedicated functional/integration test cases —
-- silently skipping it from bulk generation and wrongly blocking the
-- single-requirement "Generate" button (which refuses to run if
-- linked_test_case_count > 0). Real bug, found live in production data
-- across three projects. The two systems are fully independent now.
CREATE TABLE IF NOT EXISTS flow_requirements (
  id             SERIAL PRIMARY KEY,
  test_case_id   INTEGER REFERENCES test_cases(id) ON DELETE CASCADE,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(test_case_id, requirement_id)
);
CREATE INDEX IF NOT EXISTS idx_flow_requirements_test_case ON flow_requirements(test_case_id);
CREATE INDEX IF NOT EXISTS idx_flow_requirements_requirement ON flow_requirements(requirement_id);

CREATE TABLE IF NOT EXISTS requirement_documents (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  filename     TEXT,
  raw_text     TEXT NOT NULL,
  uploaded_by  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requirement_documents_project ON requirement_documents(project_id);

ALTER TABLE requirements ADD COLUMN IF NOT EXISTS
  document_id INTEGER REFERENCES requirement_documents(id) ON DELETE SET NULL;

ALTER TABLE automation_suites ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web'
  CHECK (platform IN ('web','ios','android'));
ALTER TABLE automation_suites ADD COLUMN IF NOT EXISTS engine TEXT
  CHECK (engine IN ('playwright','maestro','appium'));

ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web'
  CHECK (platform IN ('web','mobile'));
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web'
  CHECK (platform IN ('web','mobile'));

CREATE INDEX IF NOT EXISTS idx_test_cases_platform ON test_cases(project_id, platform);
CREATE INDEX IF NOT EXISTS idx_requirements_platform ON requirements(project_id, platform);

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual'
  CHECK (origin IN ('manual','automated'));
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS suite_id INTEGER REFERENCES automation_suites(id) ON DELETE SET NULL;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS test_run_id INTEGER REFERENCES test_runs(id) ON DELETE SET NULL;
ALTER TABLE bugs ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS screenshot_data TEXT;

CREATE INDEX IF NOT EXISTS idx_bugs_suite ON bugs(suite_id);
CREATE INDEX IF NOT EXISTS idx_bugs_test_run ON bugs(test_run_id);

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS is_environmental BOOLEAN NOT NULL DEFAULT false;

-- ============================================================================
-- Feature grouping — requirements/test cases/bugs by feature
-- ============================================================================

CREATE TABLE IF NOT EXISTS features (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'features_project_name_unique'
  ) THEN
    ALTER TABLE features
      ADD CONSTRAINT features_project_name_unique UNIQUE (project_id, name);
  END IF;
END $$;

ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL;
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_test_cases_feature ON test_cases(feature_id);
CREATE INDEX IF NOT EXISTS idx_requirements_feature ON requirements(feature_id);
CREATE INDEX IF NOT EXISTS idx_bugs_feature ON bugs(feature_id);

-- Requirements Intelligence (Phase 2.2) — AI-assessed at upload/diff time
-- only (not backfilled onto existing untouched requirements), staff-only
-- fields (stripped from GET / for the client role, same as automation's
-- review_status/origin).
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS ambiguity_flag TEXT;
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS estimated_effort TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'requirements_estimated_effort_check'
  ) THEN
    ALTER TABLE requirements ADD CONSTRAINT requirements_estimated_effort_check
      CHECK (estimated_effort IS NULL OR estimated_effort IN ('S','M','L'));
  END IF;
END $$;

-- API testing (Phase 1) — a suite is 'api'-engine on platform='web' (routes
-- through the same web generation/run workflow every UI web suite already
-- uses; see automationTrigger.js, which only ever branches on platform,
-- never engine). Widening the original inline CHECK from
-- automation_suites' own ADD COLUMN above, same drop-then-recreate pattern
-- already used for execution_run_test_cases_status_check.
ALTER TABLE automation_suites DROP CONSTRAINT IF EXISTS automation_suites_engine_check;
ALTER TABLE automation_suites ADD CONSTRAINT automation_suites_engine_check
  CHECK (engine IN ('playwright','maestro','appium','api'));

-- Per-project test environment (target URL, mobile app ids, test login
-- credentials) — the real target/credential config every CI workflow
-- actually dispatches against. Its own table, not columns on projects, so
-- test_credentials never rides along on the general GET /projects/:id
-- response every role already hits (see routes/projects.js's test-config
-- endpoints — staff-only, GET never returns the raw password). Falls back
-- to the existing hardcoded env-var defaults when a project has no row
-- here yet (see lib/testEnvironment.js), so the current demo project keeps
-- working with zero setup.
CREATE TABLE IF NOT EXISTS project_test_config (
  project_id            INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  target_url            TEXT,
  api_base_url          TEXT,
  mobile_app_id_ios     TEXT,
  mobile_app_id_android TEXT,
  test_credentials      JSONB,
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
`
