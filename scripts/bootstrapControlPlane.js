// One-time (idempotent) bootstrap for Phase A, Part 2: applies the
// control-plane schema to the current shared DB and seeds `tenants` +
// `tenant_members` rows for the projects that already exist there.
//
// Safe to re-run: CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO
// NOTHING throughout. Does NOT touch any existing table's data or schema —
// purely additive. `tenants.db_name` is seeded with a placeholder value
// since Part 3's tenantPool resolver is an identity resolver (every tenant
// id routes to this same shared DB) until Part 5's real per-tenant cutover
// assigns real db_name values.
//
// Run with: node scripts/bootstrapControlPlane.js
import 'dotenv/config'
import { pool } from '../src/db/pool.js'
import { CONTROL_PLANE_SCHEMA_SQL } from '../src/db/schema/controlPlaneSchema.js'

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

async function main() {
  console.log('Applying control-plane schema...')
  await pool.query(CONTROL_PLANE_SCHEMA_SQL)

  const { rows: projects } = await pool.query(`SELECT id, name FROM projects ORDER BY id`)
  console.log(`Seeding tenants for ${projects.length} existing project(s)...`)

  for (const p of projects) {
    const slug = slugify(p.name)
    const dbName = `legacy-shared-${p.id}`
    await pool.query(
      `INSERT INTO tenants (id, slug, db_name, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [p.id, slug, dbName]
    )
    // Keep the sequence ahead of any explicitly-inserted ids above, same
    // reasoning provisionTenant.js will need later for `projects.id`.
    await pool.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`)
    console.log(`  tenant ${p.id} (${slug}) <- project "${p.name}"`)
  }

  const { rows: members } = await pool.query(`SELECT project_id, user_id, role FROM project_members`)
  console.log(`Mirroring ${members.length} project_members row(s) into tenant_members...`)
  for (const m of members) {
    await pool.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [m.project_id, m.user_id, m.role]
    )
  }

  console.log('Done.')
  await pool.end()
}

main().catch(err => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
