// One-time backfill, run once by hand after "New project -> zero suites"
// dead end was fixed (provisionTenant.js now seeds a default suite for
// every NEW project). Existing tenants provisioned before that fix could
// still have zero automation_suites rows, leaving "Generate automated
// tests" with nowhere to target — this gives each of them the same default
// web suite new projects now get automatically.
//
// Only tenants with zero suites get one — a tenant that already has suites
// (even non-web-only ones) isn't the dead end this fixes, so it's left
// alone rather than force-adding a redundant suite.
//
// Usage: node scripts/seedDefaultSuite.js
import 'dotenv/config'
import { pool as controlPool } from '../src/db/pool.js'
import { listAllTenants } from '../src/db/tenantRegistry.js'
import { resolveTenantPool } from '../src/db/tenantPool.js'

async function main() {
  const tenants = await listAllTenants()
  console.log(`Checking ${tenants.length} tenant(s)...`)

  for (const t of tenants) {
    const db = await resolveTenantPool(t.id)
    if (!db) {
      console.log(`  tenant ${t.id} (${t.slug}) — status='${t.status}', skipping`)
      continue
    }
    const { rows: existing } = await db.query(`SELECT COUNT(*)::int AS count FROM automation_suites`)
    if (existing[0].count > 0) {
      console.log(`  tenant ${t.id} (${t.slug}): already has ${existing[0].count} suite(s), skipping`)
      continue
    }
    await db.query(
      `INSERT INTO automation_suites (project_id, name, slug, platform) VALUES ($1,'E2E Critical Flow','e2e-critical-flow','web')`,
      [t.id]
    )
    console.log(`  tenant ${t.id} (${t.slug}): seeded default "E2E Critical Flow" suite`)
  }

  console.log('Done.')
  await controlPool.end()
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
