// One-time fix, run once by hand after flow_requirements ships (see
// criticalFlows.js). Critical flows were originally linked to requirements
// via requirement_test_cases — the same table regular per-requirement test
// case generation uses for coverage tracking. That made a requirement look
// "covered" the moment any flow touched it, silently skipping it from bulk
// generation and wrongly blocking the single-requirement "Generate" button.
// Moves every existing flow's requirement links (any type='e2e' test case,
// regardless of current automation_candidate — a demoted flow's old links
// need moving too) from requirement_test_cases into the new dedicated
// flow_requirements table, then removes them from requirement_test_cases.
//
// Usage: node scripts/migrateFlowRequirementLinks.js
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

    const { rows: toMove } = await db.query(`
      SELECT rtc.id, rtc.test_case_id, rtc.requirement_id
      FROM requirement_test_cases rtc
      JOIN test_cases tc ON tc.id = rtc.test_case_id
      WHERE tc.type = 'e2e'
    `)

    if (toMove.length === 0) {
      console.log(`  tenant ${t.id} (${t.slug}): nothing to move`)
      continue
    }

    for (const row of toMove) {
      await db.query(
        `INSERT INTO flow_requirements (test_case_id, requirement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [row.test_case_id, row.requirement_id]
      )
    }
    const { rowCount } = await db.query(
      `DELETE FROM requirement_test_cases WHERE id = ANY($1::int[])`,
      [toMove.map(r => r.id)]
    )
    console.log(`  tenant ${t.id} (${t.slug}): moved ${toMove.length} link(s), deleted ${rowCount} from requirement_test_cases`)
  }

  console.log('Done.')
  await controlPool.end()
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
