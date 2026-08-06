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

-- Quick-reference external links for the project banner (client website,
-- UAT environment, socials, etc) — an array of {label, url} objects,
-- staff-edited, shown to both staff and client roles. Separate from
-- test-config's target_url (the real CI dispatch target, staff-only) —
-- these are for humans to click through, not for automation.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]';

-- Project logo/profile picture, staff-uploaded, shown to both staff and
-- client roles. Same base64-data-URL-in-column pattern already used for
-- bug attachments/comments (see bugs.js IMAGE_DATA_URL) — no object storage
-- configured for this app, see lib/imageUpload.js on the client.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo TEXT;

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

-- 'api' test cases (Phase 1 API testing) — a distinct category from
-- functional/integration/e2e so a test verifying backend/API behavior
-- (endpoints, status codes, request/response shapes) is classified as such
-- from the moment AI parses it out of a requirement, not just once staff
-- later happens to attach it to an api-engine automation suite. Widening
-- the original inline CHECK the same way automation_suites.engine was
-- widened above.
ALTER TABLE test_cases DROP CONSTRAINT IF EXISTS test_cases_type_check;
ALTER TABLE test_cases ADD CONSTRAINT test_cases_type_check
  CHECK (type IN ('functional','integration','e2e','api'));

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

-- A "grouped run" is a set of diagnostic re-runs dispatched together from
-- the Engineering page. The CI trigger mechanism only ever dispatches one
-- workflow per suite, so a group spanning multiple suites still fans out to
-- one test_runs row per suite — this table is just the label/anchor tying
-- those rows together. A group of exactly one child renders as a plain
-- individual run; render code decides that, not the schema.
CREATE TABLE IF NOT EXISTS run_groups (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS run_group_id INTEGER REFERENCES run_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_test_runs_run_group ON test_runs(run_group_id);

CREATE TABLE IF NOT EXISTS test_run_results (
  id            SERIAL PRIMARY KEY,
  test_run_id   INTEGER REFERENCES test_runs(id) ON DELETE CASCADE,
  test_title    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('passed','failed','skipped')),
  duration_ms   INTEGER,
  error_message TEXT
);

-- Captured request/response pairs for a failed API-engine test (see
-- helpers/apiTrace.ts) — an array of {method,url,requestBody,status,
-- responseBody,...} objects, one per HTTP call made during the test. Null
-- for web/mobile results, which never produce this attachment.
ALTER TABLE test_run_results ADD COLUMN IF NOT EXISTS api_trace JSONB;

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

-- Set true when an automated failure reopens a bug that was previously
-- marked resolved (see webhooks.js's isRegression branch) — stays true
-- permanently once set, even after the bug is resolved again, since "this
-- has come back before" is a real signal worth keeping visible, not just
-- while the bug happens to be currently open.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS is_regression BOOLEAN NOT NULL DEFAULT false;

-- API-engine suites have no browser/page at all, so screenshot_data is
-- never populated for a bug filed from one — this is the equivalent
-- evidence (the request/response trace, same shape ApiTraceModal already
-- renders for a Lab result), attached by webhooks.js when the failing
-- result carries one.
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS api_trace JSONB;

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

-- generation_runs.kind gains 'auth_setup' — the auth-setup generation
-- pipeline (see lib/authSetupStatus.js, lib/automationTrigger.js's
-- triggerAuthSetupRun): rows of this kind have suite_id=NULL (not
-- suite-scoped) and reuse target_title to stash the target_url they were
-- generated against, so status resolution can detect a stale run after a
-- project's target changes. Same drop-then-recreate pattern as
-- automation_suites_engine_check above.
ALTER TABLE generation_runs DROP CONSTRAINT IF EXISTS generation_runs_kind_check;
ALTER TABLE generation_runs ADD CONSTRAINT generation_runs_kind_check
  CHECK (kind IN ('generate','heal','auth_setup'));

-- Archived (not deleted) state for test_cases — set when a test case loses
-- its LAST linked requirement, either via the diff-based generation review
-- (lib/archiveOrphans.js, requirements.js's generate-test-cases/apply) or
-- the existing manual "Unlink" action. NULL = visible in the default Test
-- Cases list (every existing row today, unchanged); non-null = hidden by
-- default, viewable via GET /test-cases?archived=true. Deliberately only
-- transition-triggered, not retroactive — a test case that already has zero
-- links today stays exactly as visible as it is now.
ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Persisted live-agent-log lines for a generation run (see
-- routes/webhooks.js's POST /generation-logs) — append-only, id order is
-- display order. Lets the frontend log viewer (AutomationPage.jsx's
-- GenerationLogModal) show the full transcript for a run that's still in
-- progress AND one that already finished, not just a live tail.
-- test_runs.status gains 'cancelled' — a user-initiated stop from the
-- frontend (see automation.js's POST /runs/:runId/cancel). Terminal, like
-- completed/failed: the stale-run sweep ignores it, and the /test-runs
-- results webhook deliberately does NOT overwrite it (the GH workflow keeps
-- running for now — cancelling the actual workflow is a known later fix —
-- so its eventual report must not silently resurrect a run the user
-- already dismissed). Same drop-then-recreate pattern as the other CHECK
-- migrations above.
ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_status_check;
ALTER TABLE test_runs ADD CONSTRAINT test_runs_status_check
  CHECK (status IN ('pending','running','completed','failed','cancelled'));

CREATE TABLE IF NOT EXISTS generation_run_logs (
  id                 SERIAL PRIMARY KEY,
  generation_run_id  INTEGER REFERENCES generation_runs(id) ON DELETE CASCADE,
  line               TEXT NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generation_run_logs_run ON generation_run_logs(generation_run_id);

-- The GitHub Actions run itself, not the resulting PR — generation_runs had
-- pr_url/branch_name but nothing pointing at the workflow run that produced
-- them, unlike test_runs (which already has github_run_url). Needed so the
-- Engineering page's generation-history chips can link straight to the live
-- CI run instead of only the eventual PR (which doesn't exist yet while a
-- run is still in progress or if it fails before opening one).
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS github_run_url TEXT;

-- Caches a planner's live-verified plan for a test case so a retry (or a
-- second suite reusing the same TC) doesn't re-derive and re-verify it from
-- scratch every time. Confirmed live (2026-08-05, TC-72): the planner
-- burned a live-verification pass discovering the same real API quirk
-- (wrong endpoint assumed by the original test case) on 3 separate runs,
-- because specs/*.md is always rebuilt fresh from test_cases.steps/expected
-- and nothing ever carried the refined result forward.
--
-- One row per test case (PRIMARY KEY, not a history table) — only the most
-- recent verified plan is worth keeping. source_hash is a hash of the exact
-- inputs buildPlanMarkdown uses (title+steps+expected): if the test case
-- changes, the hash no longer matches on lookup and the cache is silently
-- treated as a miss, so there's no separate invalidation step to remember —
-- an upsert on the next successful verification just overwrites it in place.
CREATE TABLE IF NOT EXISTS test_case_verified_plans (
  test_case_id  INTEGER PRIMARY KEY REFERENCES test_cases(id) ON DELETE CASCADE,
  source_hash   TEXT NOT NULL,
  markdown      TEXT NOT NULL,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Saved Views — a named, reusable filter combination for the Bugs page or
-- the execution-run test-case list, replacing the old static "Reports"
-- launcher grid. Shared team-wide (no ownership/visibility column):
-- created_by is audit-only, same role bugs.created_by plays, never used to
-- scope who can see a view. An execution_test_cases view deliberately
-- carries no run id in its filters — it always reopens against whichever
-- execution run is most recent (see GET /execution-runs/latest), so a
-- saved/shared link never goes stale as new runs happen.
--
-- filters JSON shapes:
--   bugs: { severity, status, source, dateLogged: { preset, from, to },
--           environmentalOnly, executionRunId, suiteId }
--   execution_test_cases: { status, type }
CREATE TABLE IF NOT EXISTS saved_views (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('bugs','execution_test_cases')),
  filters      JSONB NOT NULL DEFAULT '{}',
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_views_project ON saved_views(project_id);

-- Which UI surface actually dispatched a run — trigger_type only says
-- manual vs nightly, not WHICH manual surface (Automation page's "Run now",
-- the Executions page's per-suite run, or Engineering's re-run/group-rerun
-- actions), and all of those funnel through the same triggerSuiteRun/
-- triggerTestCaseRerun functions server-side. NULL for any row that
-- predates this column.
ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS triggered_from TEXT;
`
