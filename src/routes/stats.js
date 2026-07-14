import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

// Cross-project activity feed, same "infer from current-state timestamps"
// approach as the per-project QualityHealth dashboard client-side — just
// done here in SQL since building it client-side would mean an N+1 fetch
// (bugs + execution-runs per project) instead of one query each.
function bugEvent(b) {
  return b.status === 'resolved'
    ? { kind: 'bug_resolved', text: `Bug #${b.id} "${b.title}" resolved`, projectName: b.project_name, time: b.updated_at }
    : { kind: 'bug_reported', text: `Bug #${b.id} "${b.title}" reported`, severity: b.severity, projectName: b.project_name, time: b.created_at }
}
function runEvent(r) {
  return { kind: 'execution_run', text: `Execution run "${r.name}" finished — ${r.passed}/${r.total} passed`, projectName: r.project_name, time: r.completed_at }
}

router.get('/', async (req, res) => {
  try {
    // passed/failed sourced from real execution history, not test_cases.status
    // — see the identical fix (and the reasoning for it) on
    // GET /projects/:id/health in projects.js. Not scoping latest_execution
    // by project here since this is a global, cross-project aggregate;
    // test_case_id is already project-scoped via the tc join below, so no
    // cross-project leakage.
    const [mainRows, bugSevRows, coverageRows, recentBugRows, recentRunRows, attentionRows] = await Promise.all([
      query(`
        WITH latest_execution AS (
          SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status
          FROM execution_run_test_cases erc
          WHERE erc.status != 'not_run'
          ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
        )
        SELECT
          COUNT(DISTINCT p.id)::int AS projects,
          COUNT(DISTINCT tc.id)::int AS "testCases",
          COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'pass')::int AS passed,
          COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'fail')::int AS failed,
          COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'blocked')::int AS blocked,
          COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id = p.id
        LEFT JOIN latest_execution le ON le.test_case_id = tc.id
        LEFT JOIN bugs b ON b.project_id = p.id
      `),
      query(`SELECT severity, COUNT(*)::int AS count FROM bugs WHERE status='open' GROUP BY severity`),
      query(`
        SELECT
          COUNT(DISTINCT tc.id)::int AS total,
          COUNT(DISTINCT tc.id) FILTER (WHERE atc.id IS NOT NULL)::int AS automated
        FROM test_cases tc
        LEFT JOIN automated_test_cases atc ON atc.test_case_id = tc.id
      `),
      query(`
        SELECT b.id, b.title, b.severity, b.status, b.created_at, b.updated_at, p.name AS project_name
        FROM bugs b JOIN projects p ON p.id = b.project_id
        ORDER BY GREATEST(b.created_at, b.updated_at) DESC
        LIMIT 10
      `),
      query(`
        SELECT er.id, er.name, er.completed_at, p.name AS project_name,
          COUNT(erc.id) FILTER (WHERE erc.status='pass')::int AS passed,
          COUNT(erc.id) FILTER (WHERE erc.status IN ('pass','fail'))::int AS total
        FROM execution_runs er
        JOIN projects p ON p.id = er.project_id
        JOIN execution_run_test_cases erc ON erc.execution_run_id = er.id
        WHERE er.status = 'completed'
        GROUP BY er.id, er.name, er.completed_at, p.name
        ORDER BY er.completed_at DESC
        LIMIT 8
      `),
      query(`
        SELECT b.id, b.title, b.severity, b.created_at, p.name AS project_name
        FROM bugs b JOIN projects p ON p.id = b.project_id
        WHERE b.status != 'resolved' AND b.severity IN ('critical','high')
        ORDER BY CASE b.severity WHEN 'critical' THEN 1 ELSE 2 END, b.created_at ASC
        LIMIT 5
      `),
    ])

    const stats = mainRows.rows[0]

    const bugsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const row of bugSevRows.rows) bugsBySeverity[row.severity] = row.count

    const cov = coverageRows.rows[0]
    const automationCoverage = cov.total > 0 ? Math.round((cov.automated / cov.total) * 100) : null

    const passRate = stats.testCases > 0 ? Math.round((stats.passed / stats.testCases) * 100) : null

    const recentActivity = [
      ...recentBugRows.rows.map(bugEvent),
      ...recentRunRows.rows.map(runEvent),
    ].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8)

    const recentRuns = recentRunRows.rows.slice(0, 5).map(r => ({
      projectName: r.project_name, runName: r.name, passed: r.passed, total: r.total, completedAt: r.completed_at,
    }))

    const needsAttention = attentionRows.rows.map(b => ({
      id: b.id, title: b.title, severity: b.severity, projectName: b.project_name, createdAt: b.created_at,
    }))

    res.json({
      ...stats,
      passRate,
      bugsBySeverity,
      automationCoverage,
      automatedTestCases: cov.automated,
      totalTestCases: cov.total,
      recentActivity,
      recentRuns,
      needsAttention,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router