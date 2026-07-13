import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

async function assertProjectAccess(req, res) {
  if (req.userRole === 'client') {
    const { rows } = await query(
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2`,
      [req.params.id, req.userId]
    )
    if (!rows[0]) {
      res.status(404).json({ error: 'Not found' })
      return false
    }
  }
  return true
}

// GET /projects
router.get('/', async (req, res) => {
  try {
    let rows
    if (req.userRole === 'client') {
      ;({ rows } = await query(`
        SELECT p.*,
          COUNT(DISTINCT tc.id)::int AS test_case_count,
          COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS open_bug_count
        FROM projects p
        JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
        LEFT JOIN test_cases tc ON tc.project_id = p.id
        LEFT JOIN bugs b ON b.project_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
      `, [req.userId]))
    } else {
      ;({ rows } = await query(`
        SELECT p.*,
          COUNT(DISTINCT tc.id)::int AS test_case_count,
          COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS open_bug_count
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id = p.id
        LEFT JOIN bugs b ON b.project_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
      `))
    }
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects — admin only
router.post('/', requireRole('admin'), async (req, res) => {
  const { name, client_name, description } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  try {
    await query(
      `INSERT INTO users (id, email, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [req.userId, req.userEmail, req.userRole]
    )
    const { rows } = await query(
      `INSERT INTO projects (name, client_name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name.trim(), client_name?.trim() || null, description?.trim() || null, req.userId]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id
router.get('/:id', async (req, res) => {
  try {
    if (!(await assertProjectAccess(req, res))) return
    const { rows } = await query(`SELECT * FROM projects WHERE id=$1`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/stats
router.get('/:id/stats', async (req, res) => {
  try {
    if (!(await assertProjectAccess(req, res))) return
    // Same fix as GET /:id/health — passed/failed/notRun sourced from real
    // execution history (execution_run_test_cases), not test_cases.status,
    // which execution runs never write to.
    const { rows } = await query(`
      WITH latest_execution AS (
        SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status
        FROM execution_run_test_cases erc
        JOIN execution_runs er ON er.id = erc.execution_run_id
        WHERE er.project_id = $1 AND erc.status != 'not_run'
        ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
      )
      SELECT
        COUNT(DISTINCT tc.id)::int AS "testCases",
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'pass')::int AS passed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'fail')::int AS failed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'blocked')::int AS blocked,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.test_case_id IS NULL)::int AS "notRun",
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id
      LEFT JOIN latest_execution le ON le.test_case_id = tc.id
      LEFT JOIN bugs b ON b.project_id = p.id
      WHERE p.id = $1
    `, [req.params.id])
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/health — quality-health dashboard data (see DECISIONS.md
// "Phase 4 — quality health dashboard" for the healthStatus thresholds and
// why the trend is sourced from execution_runs rather than test_cases.status).
router.get('/:id/health', async (req, res) => {
  try {
    if (!(await assertProjectAccess(req, res))) return
    const projectId = req.params.id

    const [testCaseRows, bugRows, coverageRows, trendRows, requirementCoverageRows] = await Promise.all([
      // Sourced from real execution history, not test_cases.status — that
      // column is deliberately independent of execution results (see the
      // schema comment on execution_run_test_cases in migrate.js), so it
      // never reflected an actual run. This finds each test case's most
      // recent real pass/fail/blocked result across every execution run in
      // the project and aggregates from that instead.
      query(`
        WITH latest_execution AS (
          SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status
          FROM execution_run_test_cases erc
          JOIN execution_runs er ON er.id = erc.execution_run_id
          WHERE er.project_id = $1 AND erc.status != 'not_run'
          ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
        )
        SELECT
          COUNT(DISTINCT tc.id)::int AS total,
          COUNT(DISTINCT le.test_case_id) FILTER (WHERE le.status = 'pass')::int AS passed,
          COUNT(DISTINCT le.test_case_id) FILTER (WHERE le.status = 'fail')::int AS failed,
          COUNT(DISTINCT le.test_case_id) FILTER (WHERE le.status = 'blocked')::int AS blocked,
          COUNT(DISTINCT tc.id) FILTER (WHERE le.test_case_id IS NULL)::int AS "notRun"
        FROM test_cases tc
        LEFT JOIN latest_execution le ON le.test_case_id = tc.id
        WHERE tc.project_id = $1
      `, [projectId]),
      query(`
        SELECT severity, COUNT(*)::int AS count
        FROM bugs
        WHERE project_id = $1 AND status = 'open'
        GROUP BY severity
      `, [projectId]),
      query(`
        SELECT
          COUNT(DISTINCT tc.id)::int AS total,
          COUNT(DISTINCT tc.id) FILTER (WHERE atc.id IS NOT NULL)::int AS automated
        FROM test_cases tc
        LEFT JOIN automated_test_cases atc ON atc.test_case_id = tc.id
        WHERE tc.project_id = $1
      `, [projectId]),
      query(`
        SELECT er.id, er.completed_at,
          COUNT(erc.id) FILTER (WHERE erc.status = 'pass')::int AS passed,
          COUNT(erc.id) FILTER (WHERE erc.status IN ('pass','fail'))::int AS total
        FROM execution_runs er
        JOIN execution_run_test_cases erc ON erc.execution_run_id = er.id
        WHERE er.project_id = $1 AND er.status = 'completed'
        GROUP BY er.id, er.completed_at
        ORDER BY er.completed_at DESC
        LIMIT 8
      `, [projectId]),
      // Same "has at least one link" definition of coverage already used on
      // the Requirements page itself (linked_test_case_count > 0) — kept
      // identical on purpose so this dashboard and that page never disagree
      // about what "covered" means.
      query(`
        SELECT
          COUNT(DISTINCT r.id)::int AS total,
          COUNT(DISTINCT r.id) FILTER (WHERE rtc.id IS NOT NULL)::int AS covered
        FROM requirements r
        LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
        WHERE r.project_id = $1 AND r.status = 'active'
      `, [projectId]),
    ])

    const tc = testCaseRows.rows[0]
    const passRate = tc.total > 0 ? Math.round((tc.passed / tc.total) * 100) : null

    const bugsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const row of bugRows.rows) bugsBySeverity[row.severity] = row.count

    const cov = coverageRows.rows[0]
    const automationCoverage = cov.total > 0 ? Math.round((cov.automated / cov.total) * 100) : null

    const reqCov = requirementCoverageRows.rows[0]
    const requirementCoverage = reqCov.total > 0 ? Math.round((reqCov.covered / reqCov.total) * 100) : null

    const passRateTrend = trendRows.rows
      .filter(r => r.total > 0)
      .map(r => ({ date: r.completed_at, passRate: Math.round((r.passed / r.total) * 100) }))
      .reverse()

    let healthStatus
    if (passRate === null) {
      healthStatus = 'insufficient_data'
    } else if (bugsBySeverity.critical > 0 || passRate < 70) {
      healthStatus = 'needs_attention'
    } else if (bugsBySeverity.high > 0 || passRate < 90) {
      healthStatus = 'good'
    } else {
      healthStatus = 'excellent'
    }

    res.json({
      healthStatus,
      passRate,
      testCases: { total: tc.total, passed: tc.passed, failed: tc.failed, blocked: tc.blocked, notRun: tc.notRun },
      bugsBySeverity,
      automationCoverage,
      automatedTestCases: cov.automated,
      totalTestCases: cov.total,
      requirementCoverage,
      coveredRequirements: reqCov.covered,
      totalRequirements: reqCov.total,
      passRateTrend,
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/members — admin only, links a client user to a project
router.post('/:id/members', requireRole('admin'), async (req, res) => {
  const { email } = req.body
  if (!email?.trim()) return res.status(400).json({ error: 'Email is required' })

  try {
    const { rows: userRows } = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()])
    if (!userRows[0]) return res.status(404).json({ error: 'No user with that email has registered yet' })

    await query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'client')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [req.params.id, userRows[0].id]
    )
    res.status(201).json({ added: email })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/members — admin only, lists clients this project has been shared with
router.get('/:id/members', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.name
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1 AND pm.role = 'client'
       ORDER BY u.email`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// DELETE /projects/:id/members/:userId — admin only, revokes a client's access
router.delete('/:id/members/:userId', requireRole('admin'), async (req, res) => {
  try {
    await query(
      `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`,
      [req.params.id, req.params.userId]
    )
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router