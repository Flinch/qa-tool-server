// One-time cleanup, run once by hand after automationGuidance.js's tightened
// guidance ships (see "Critical E2E flows" plan). automation_candidate used
// to mean "technically scriptable," so plenty of existing functional/
// integration test cases across real tenants are flagged true under that
// old, looser meaning. Now that automation_candidate is reserved for the
// curated critical-flow set (type='e2e' + automation_candidate=true), those
// stragglers need to be demoted so the Automation page's "critical flows"
// view is accurate immediately, not just for test cases generated after
// this ships.
//
// Usage: node scripts/clearStaleAutomationCandidates.js
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
    const { rows } = await db.query(
      `UPDATE test_cases SET automation_candidate=false, automation_reasoning=NULL
       WHERE automation_candidate=true AND type != 'e2e'
       RETURNING id`
    )
    console.log(`  tenant ${t.id} (${t.slug}): ${rows.length} test case(s) demoted`)
  }

  console.log('Done.')
  await controlPool.end()
}

main().catch(err => {
  console.error('Cleanup failed:', err)
  process.exit(1)
})
