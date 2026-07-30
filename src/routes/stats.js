import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { listVisibleTenants } from '../db/tenantRegistry.js'
import { resolveTenantPool } from '../db/tenantPool.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

// Cross-project activity feed, same "infer from current-state timestamps"
// approach as the per-project QualityHealth dashboard client-side.
function bugEvent(b) {
  return b.status === 'resolved'
    ? { kind: 'bug_resolved', text: `Bug #${b.id} "${b.title}" resolved`, bugId: b.id, projectId: b.project_id, projectName: b.project_name, time: b.updated_at }
    : { kind: 'bug_reported', text: `Bug #${b.id} "${b.title}" reported`, severity: b.severity, bugId: b.id, projectId: b.project_id, projectName: b.project_name, time: b.created_at }
}
function runEvent(r) {
  return { kind: 'execution_run', text: `Execution run "${r.name}" finished — ${r.passed}/${r.total} passed`, runId: r.id, projectId: r.project_id, projectName: r.project_name, time: r.completed_at }
}

// This dashboard used to be one global SQL query across every project in a
// shared DB. Now each project lives in its own database (Phase A: DB-per-
// client multi-tenancy), so it's a per-tenant query fanned out in parallel,
// merged/re-sorted/re-sliced in Node. Over-fetches the "recent"/"top N"
// lists per tenant (10/8/5 here vs. the final 8/5/5 returned) since the
// globally-most-recent items aren't necessarily any one tenant's own most
// recent — under-fetching per tenant could silently drop a real top item.
//
// Every query below still filters by project_id=$1 even though, once real
// per-tenant databases exist (Part 5), a tenant's db only ever has one
// project's rows anyway. During the identity-resolver bridge (now), every
// tenant still shares the ONE physical database — without this filter each
// call silently returns every OTHER tenant's data too, not just this one's.
// Caught live via this exact bug in GET /projects's fan-out query; fixed
// there and here at the same time. Zero downside to keeping it permanently.
async function fetchTenantStats(db, tenantId) {
  const [testCaseRows, bugSevRows, openBugRows, coverageRows, recentBugRows, recentRunRows, attentionRows] = await Promise.all([
    db.query(`
      WITH latest_execution AS (
        SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status
        FROM execution_run_test_cases erc
        JOIN execution_runs er ON er.id = erc.execution_run_id
        WHERE erc.status != 'not_run' AND er.project_id = $1
        ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
      )
      SELECT
        COUNT(DISTINCT tc.id)::int AS "testCases",
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'pass')::int AS passed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'fail')::int AS failed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'blocked')::int AS blocked
      FROM test_cases tc
      LEFT JOIN latest_execution le ON le.test_case_id = tc.id
      WHERE tc.project_id = $1
    `, [tenantId]),
    db.query(`SELECT severity, COUNT(*)::int AS count FROM bugs WHERE status='open' AND project_id=$1 GROUP BY severity`, [tenantId]),
    db.query(`SELECT COUNT(*)::int AS count FROM bugs WHERE status='open' AND project_id=$1`, [tenantId]),
    db.query(`
      SELECT
        COUNT(DISTINCT tc.id)::int AS total,
        COUNT(DISTINCT tc.id) FILTER (WHERE atc.id IS NOT NULL)::int AS automated
      FROM test_cases tc
      LEFT JOIN automated_test_cases atc ON atc.test_case_id = tc.id
      WHERE tc.project_id = $1
    `, [tenantId]),
    db.query(`
      SELECT b.id, b.project_id, b.title, b.severity, b.status, b.created_at, b.updated_at, p.name AS project_name
      FROM bugs b JOIN projects p ON p.id = b.project_id
      WHERE b.project_id = $1
      ORDER BY GREATEST(b.created_at, b.updated_at) DESC
      LIMIT 10
    `, [tenantId]),
    db.query(`
      SELECT er.id, er.project_id, er.name, er.completed_at, p.name AS project_name,
        COUNT(erc.id) FILTER (WHERE erc.status='pass')::int AS passed,
        COUNT(erc.id) FILTER (WHERE erc.status IN ('pass','fail'))::int AS total
      FROM execution_runs er
      JOIN projects p ON p.id = er.project_id
      JOIN execution_run_test_cases erc ON erc.execution_run_id = er.id
      WHERE er.status = 'completed' AND er.project_id = $1
      GROUP BY er.id, er.project_id, er.name, er.completed_at, p.name
      ORDER BY er.completed_at DESC
      LIMIT 8
    `, [tenantId]),
    db.query(`
      SELECT b.id, b.project_id, b.title, b.severity, b.created_at, p.name AS project_name
      FROM bugs b JOIN projects p ON p.id = b.project_id
      WHERE b.status != 'resolved' AND b.severity IN ('critical','high') AND b.project_id = $1
      ORDER BY CASE b.severity WHEN 'critical' THEN 1 ELSE 2 END, b.created_at ASC
      LIMIT 5
    `, [tenantId]),
  ])

  return {
    testCases: testCaseRows.rows[0],
    bugsBySeverity: bugSevRows.rows,
    openBugs: openBugRows.rows[0].count,
    coverage: coverageRows.rows[0],
    recentBugs: recentBugRows.rows,
    recentRuns: recentRunRows.rows,
    attentionBugs: attentionRows.rows,
  }
}

router.get('/', async (req, res) => {
  try {
    const tenants = await listVisibleTenants(req.userId, req.userRole)
    const settled = await Promise.allSettled(tenants.map(async t => fetchTenantStats(await resolveTenantPool(t.id), t.id)))
    const perTenant = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') perTenant.push(r.value)
      else console.error(`GET /stats: tenant ${tenants[i].id} (${tenants[i].slug}) unreachable:`, r.reason)
    })

    let testCases = 0, passed = 0, failed = 0, blocked = 0, openBugs = 0
    let covTotal = 0, covAutomated = 0
    const bugsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    let recentBugRows = [], recentRunRows = [], attentionRows = []

    for (const t of perTenant) {
      testCases += t.testCases.testCases
      passed += t.testCases.passed
      failed += t.testCases.failed
      blocked += t.testCases.blocked
      openBugs += t.openBugs
      covTotal += t.coverage.total
      covAutomated += t.coverage.automated
      for (const row of t.bugsBySeverity) bugsBySeverity[row.severity] = (bugsBySeverity[row.severity] || 0) + row.count
      recentBugRows = recentBugRows.concat(t.recentBugs)
      recentRunRows = recentRunRows.concat(t.recentRuns)
      attentionRows = attentionRows.concat(t.attentionBugs)
    }

    const automationCoverage = covTotal > 0 ? Math.round((covAutomated / covTotal) * 100) : null
    const passRate = testCases > 0 ? Math.round((passed / testCases) * 100) : null

    const recentActivity = [
      ...recentBugRows.map(bugEvent),
      ...recentRunRows.map(runEvent),
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8)

    const recentRuns = recentRunRows
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
      .slice(0, 5)
      .map(r => ({
        runId: r.id, projectId: r.project_id, projectName: r.project_name, runName: r.name, passed: r.passed, total: r.total, completedAt: r.completed_at,
      }))

    const needsAttention = attentionRows
      .sort((a, b) => {
        const sevOrder = { critical: 1, high: 2 }
        return (sevOrder[a.severity] - sevOrder[b.severity]) || (new Date(a.created_at) - new Date(b.created_at))
      })
      .slice(0, 5)
      .map(b => ({
        id: b.id, projectId: b.project_id, title: b.title, severity: b.severity, projectName: b.project_name, createdAt: b.created_at,
      }))

    res.json({
      projects: perTenant.length,
      testCases,
      passRate,
      openBugs,
      bugsBySeverity,
      automationCoverage,
      automatedTestCases: covAutomated,
      totalTestCases: covTotal,
      recentActivity,
      recentRuns,
      needsAttention,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
