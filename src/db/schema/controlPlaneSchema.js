// Control-plane schema: identity + tenant routing metadata only. Deliberately
// does NOT hold any client QA data (test cases, bugs, runs, etc.) — that all
// lives in each tenant's own physically separate database (see
// tenantSchema.js). Staff (qa_engineer/admin) authenticate here once and
// reach every tenant; client-role users are scoped to specific tenants via
// tenant_members. See modular-sniffing-balloon.md ("Phase A: DB-per-client
// multi-tenancy") for the full design.

export const CONTROL_PLANE_SCHEMA_SQL = `
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

-- One row per client. id is deliberately made to equal the sole projects.id
-- row inside that tenant's own database (enforced at provisioning time, not
-- by a DB constraint here, since the two ids live in different databases) —
-- that's what lets every existing :id route param keep meaning "project id"
-- unchanged after being resolved through this table first.
CREATE TABLE IF NOT EXISTS tenants (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  db_name     TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'provisioning'
                CHECK (status IN ('provisioning','active','suspended','archived')),
  created_by  TEXT REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Replaces project_members for access-control purposes. Staff bypass this
-- check entirely (see requireTenantAccess) — only client-role users need a
-- row here to be granted into a tenant's workspace.
CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT DEFAULT 'client',
  PRIMARY KEY (tenant_id, user_id)
);

-- The mechanism that lets a webhook resolve which tenant DB a result belongs
-- to WITHOUT trusting anything CI claims about project_id in the payload
-- (that trust was the root cause of the original QA_TOOL_PROJECT_ID bug).
-- Written by automationTrigger.js's recordDispatch() at the same time each
-- dispatch's pending row is inserted into the tenant DB, BEFORE the GitHub
-- Actions dispatch call itself — so a crash between the two writes never
-- leaves a dispatched run with no way to resolve its tenant on the way back.
CREATE TABLE IF NOT EXISTS dispatch_index (
  correlation_id TEXT PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('test_run','generation_run')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_index_created ON dispatch_index(created_at);
`
