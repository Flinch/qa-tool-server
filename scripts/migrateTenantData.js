// Phase A, Part 5b — the real one-time data migration for the tenants that
// pre-date DB-per-client (currently all 4: Booking App, Hair Stylist App,
// Service Desk App, Sauce Labs Demo App). Copies each tenant's rows out of
// the shared legacy database into its own brand-new, real, isolated
// database — but does NOT touch tenants.db_name or resolveTenantPool's
// identity-mode routing. That's the actual cutover, a deliberately separate
// manual step (see the report this script prints at the end) — Malik
// reviews the migrated data himself before anything starts reading from it.
//
// The legacy shared database is never written to and never dropped by this
// script. Every tenant here is independently re-runnable: it drops and
// recreates its own destination database from scratch each time, so a
// partial/interrupted run is always safe to just run again.
//
// Usage:
//   node scripts/migrateTenantData.js --dry-run              # snapshot + report only, no writes
//   node scripts/migrateTenantData.js --tenant 3              # migrate one tenant
//   node scripts/migrateTenantData.js --all                   # migrate every existing tenant
import 'dotenv/config'
import pg from 'pg'
import { query as controlQuery, pool as controlPool, pool as sourcePool } from '../src/db/pool.js'
import { migrateTenant } from '../src/db/migrate.js'
import { buildTenantConnectionString } from '../src/db/tenantPool.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = (next === undefined || next.startsWith('--')) ? true : argv[++i]
    out[key] = value
  }
  return out
}

// Dependency order — parents before children, so every FK a row references
// already exists in the destination by the time that row is inserted.
// filter(projectId) returns the WHERE-clause SQL (no leading "WHERE") and
// params to select just this project's rows from the shared source DB.
// hasSerialId: whether to OVERRIDING SYSTEM VALUE + setval the sequence
// after copying (every table here has a SERIAL id except the pure join
// tables, which have no sequence to preserve).
const TABLES = [
  { table: 'projects', filter: id => ({ sql: 'id = $1', params: [id] }), hasSerialId: true },
  { table: 'features', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'requirement_documents', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'automation_suites', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'test_cases', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'requirements', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'execution_runs', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'test_runs', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'automated_test_cases', filter: id => ({ sql: 'suite_id IN (SELECT id FROM automation_suites WHERE project_id = $1)', params: [id] }), hasSerialId: true },
  { table: 'test_run_results', filter: id => ({ sql: 'test_run_id IN (SELECT id FROM test_runs WHERE project_id = $1)', params: [id] }), hasSerialId: true },
  { table: 'execution_run_test_cases', filter: id => ({ sql: 'execution_run_id IN (SELECT id FROM execution_runs WHERE project_id = $1)', params: [id] }), hasSerialId: true },
  { table: 'execution_run_suites', filter: id => ({ sql: 'execution_run_id IN (SELECT id FROM execution_runs WHERE project_id = $1)', params: [id] }), hasSerialId: true },
  { table: 'requirement_test_cases', filter: id => ({ sql: 'requirement_id IN (SELECT id FROM requirements WHERE project_id = $1)', params: [id] }), hasSerialId: true },
  { table: 'bugs', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
  { table: 'bug_comments', filter: id => ({ sql: 'bug_id IN (SELECT id FROM bugs WHERE project_id = $1)', params: [id] }), hasSerialId: true },
  { table: 'generation_runs', filter: id => ({ sql: 'project_id = $1', params: [id] }), hasSerialId: true },
]

async function snapshotCounts(db, projectId) {
  const counts = {}
  for (const t of TABLES) {
    const { sql, params } = t.filter(projectId)
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${t.table} WHERE ${sql}`, params)
    counts[t.table] = rows[0].n
  }
  return counts
}

// pg parses a JSONB column's value into a real JS value on SELECT (test_cases.
// steps comes back as an actual array). Binding that array straight back as
// an INSERT parameter is wrong: pg's default parameter serialization for a
// bare JS array produces Postgres array-literal syntax ({a,b,c}), not JSON
// text — which a jsonb column then fails to parse. Caught live on the very
// first real tenant copy. JSONB_COLUMNS lists every column that needs an
// explicit JSON.stringify() before binding; native Postgres array columns
// (test_runs.target_titles, generation_runs.test_case_ids) are NOT in this
// list — pg's default array serialization is exactly correct for those.
const JSONB_COLUMNS = { test_cases: ['steps'] }

async function copyTable(destDb, table, sourceRows) {
  if (sourceRows.length === 0) return
  const cols = Object.keys(sourceRows[0])
  const jsonbCols = new Set(JSONB_COLUMNS[table] || [])
  const colList = cols.join(', ')
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
  for (const row of sourceRows) {
    await destDb.query(
      `INSERT INTO ${table} (${colList}) OVERRIDING SYSTEM VALUE VALUES (${placeholders})`,
      cols.map(c => jsonbCols.has(c) ? JSON.stringify(row[c]) : row[c])
    )
  }
  await destDb.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}))`)
}

async function migrateOneTenant(tenantId) {
  const { rows: tenantRows } = await controlQuery(`SELECT * FROM tenants WHERE id=$1`, [tenantId])
  const tenant = tenantRows[0]
  if (!tenant) throw new Error(`No tenant with id ${tenantId}`)

  console.log(`\n=== Tenant ${tenant.id} (${tenant.slug}) ===`)

  console.log('Snapshotting source row counts...')
  const before = await snapshotCounts(sourcePool, tenantId)

  const dbName = `bp_tenant_${tenant.slug.replace(/-/g, '_')}`
  const provisioningUrl = process.env.PROVISIONING_DATABASE_URL || process.env.DATABASE_URL

  console.log(`Recreating destination database "${dbName}"...`)
  const admin = new pg.Pool({ connectionString: provisioningUrl, max: 1 })
  try {
    // DROP + CREATE, not CREATE IF NOT EXISTS: makes this tenant's migration
    // independently re-runnable from a clean slate every time, so an
    // interrupted or bug-fixed re-run never has to reason about partial
    // leftover data from a previous attempt.
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`)
    await admin.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await admin.end()
  }

  const destDb = new pg.Pool({ connectionString: buildTenantConnectionString(dbName) })
  try {
    console.log('Applying tenant schema...')
    await migrateTenant(destDb)

    for (const t of TABLES) {
      const { sql, params } = t.filter(tenantId)
      const { rows } = await sourcePool.query(`SELECT * FROM ${t.table} WHERE ${sql}`, params)
      await copyTable(destDb, t.table, rows)
      console.log(`  ${t.table}: ${rows.length} row(s) copied`)
    }

    console.log('Backfilling dispatch_index for in-flight correlation_ids...')
    const { rows: testRunCorrelations } = await destDb.query(`SELECT correlation_id FROM test_runs WHERE correlation_id IS NOT NULL`)
    for (const r of testRunCorrelations) {
      await controlQuery(
        `INSERT INTO dispatch_index (correlation_id, tenant_id, kind) VALUES ($1,$2,'test_run') ON CONFLICT (correlation_id) DO NOTHING`,
        [r.correlation_id, tenantId]
      )
    }
    const { rows: genRunCorrelations } = await destDb.query(`SELECT correlation_id FROM generation_runs WHERE correlation_id IS NOT NULL`)
    for (const r of genRunCorrelations) {
      await controlQuery(
        `INSERT INTO dispatch_index (correlation_id, tenant_id, kind) VALUES ($1,$2,'generation_run') ON CONFLICT (correlation_id) DO NOTHING`,
        [r.correlation_id, tenantId]
      )
    }
    console.log(`  ${testRunCorrelations.length + genRunCorrelations.length} correlation_id(s) backfilled`)

    console.log('Verifying row counts match...')
    const after = await snapshotCounts(destDb, tenantId)
    let allMatch = true
    for (const t of TABLES) {
      const match = before[t.table] === after[t.table]
      if (!match) allMatch = false
      console.log(`  ${t.table}: source=${before[t.table]} dest=${after[t.table]} ${match ? 'OK' : '*** MISMATCH ***'}`)
    }

    if (!allMatch) {
      throw new Error(`Row count mismatch for tenant ${tenant.id} (${tenant.slug}) — destination database left in place for inspection, NOT wired up. Fix and re-run.`)
    }

    console.log(`Tenant ${tenant.id} (${tenant.slug}) copied and verified. db_name is still "${tenant.db_name}" (legacy) — NOT yet switched to "${dbName}". That's the separate cutover step.`)
    return { tenantId: tenant.id, slug: tenant.slug, newDbName: dbName, verified: true }
  } finally {
    await destDb.end()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args['dry-run']) {
    const { rows: tenants } = await controlQuery(`SELECT * FROM tenants WHERE status != 'archived' ORDER BY id`)
    for (const t of tenants) {
      console.log(`\n=== Tenant ${t.id} (${t.slug}) — dry run, source counts only ===`)
      const counts = await snapshotCounts(sourcePool, t.id)
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`)
    }
    await controlPool.end()
    return
  }

  let tenantIds
  if (args.all) {
    const { rows } = await controlQuery(`SELECT id FROM tenants WHERE status != 'archived' ORDER BY id`)
    tenantIds = rows.map(r => r.id)
  } else if (args.tenant) {
    tenantIds = [Number(args.tenant)]
  } else {
    console.error('Usage: node scripts/migrateTenantData.js --dry-run | --tenant <id> | --all')
    process.exit(1)
  }

  const results = []
  for (const id of tenantIds) {
    results.push(await migrateOneTenant(id))
  }

  console.log('\n=== Summary ===')
  for (const r of results) console.log(`  tenant ${r.tenantId} (${r.slug}) -> ${r.newDbName}: verified`)
  console.log(
    '\nAll copied and verified. Nothing is wired up to read from these new databases yet — ' +
    'the legacy shared database is still what the running app uses (identity resolver, Phase A Part 3). ' +
    'Remaining manual cutover steps (do these deliberately, not from this script):\n' +
    '  1. Review the migrated data directly in each new database.\n' +
    '  2. Take an explicit backup of the legacy shared database.\n' +
    '  3. Brief maintenance window: freeze writes to the legacy DB, re-run this script once more\n' +
    '     to pick up anything written since the last pass, re-verify.\n' +
    '  4. Update each tenant\'s tenants.db_name to its new database name.\n' +
    '  5. Flip tenantPool.js\'s resolveTenantPool from the identity resolver to real per-tenant routing.\n' +
    '  6. Deploy, smoke-test in production.\n' +
    '  7. Leave the legacy shared database fully intact for several weeks as a safety net — do not drop it.'
  )

  await controlPool.end()
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
