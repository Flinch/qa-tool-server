import { Router } from 'express'
import { query } from '../db/pool.js' // control-plane pool
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'
import { listVisibleTenants } from '../db/tenantRegistry.js'
import { resolveTenantPool } from '../db/tenantPool.js'

const router = Router()
router.use(requireAuth)

// GET /projects — staff see every active tenant, clients only the ones
// they're a tenant_members of. Each tenant's own data (test_case_count,
// open_bug_count) now lives in a separate database per tenant, so this can
// no longer be one SQL join — fan out to each tenant's pool in parallel and
// merge in Node. Promise.allSettled so one unreachable tenant DB degrades
// to "missing from the list" instead of 500ing the whole page for everyone.
router.get('/', async (req, res) => {
  try {
    const tenants = await listVisibleTenants(req.userId, req.userRole)
    const settled = await Promise.allSettled(tenants.map(async t => {
      const db = await resolveTenantPool(t.id)
      // WHERE p.id=$1 stays even though, once real per-tenant databases
      // exist (Part 5), a tenant's db only ever has one projects row anyway
      // — during the identity-resolver bridge (now), every tenant still
      // shares the ONE physical database, so without this filter each
      // iteration silently returns whichever project row Postgres happens
      // to return first, not this tenant's own row. Caught by testing this
      // exact bug live. Zero downside to keeping it permanently.
      const { rows } = await db.query(`
        SELECT p.*,
          COUNT(DISTINCT tc.id)::int AS test_case_count,
          COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS open_bug_count
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id = p.id
        LEFT JOIN bugs b ON b.project_id = p.id
        WHERE p.id = $1
        GROUP BY p.id
      `, [t.id])
      return rows[0]
    }))
    const projects = []
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) projects.push(r.value)
      else console.error(`GET /projects: tenant ${tenants[i].id} (${tenants[i].slug}) unreachable:`, r.reason)
    })
    projects.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    res.json(projects)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST / — provisioning a new tenant (creating its own database, running
// schema migrations, seeding defaults) is deliberately NOT a live HTTP
// route. It's a CLI-only operation (scripts/provisionTenant.js) run by hand
// off the always-on server process, so the database-creation-capable
// credential it needs never has to live on that process. See "Phase A:
// DB-per-client multi-tenancy" for why.

// GET /projects/:id
router.get('/:id', requireTenantAccess, async (req, res) => {
  try {
    const { rows } = await req.db.query(`SELECT * FROM projects WHERE id=$1`, [req.params.id])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /projects/:id — inline-editable name/client_name/description from
// the project page. Staff only (matches every other project-mutation
// route). name can't be edited blank; client_name/description can (they're
// optional — an empty string clears them, same as null).
router.patch('/:id', requireTenantAccess, requireRole('qa_engineer', 'admin'), async (req, res) => {
  const { name, client_name, description } = req.body

  const fields = []
  const values = []
  let i = 1

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' })
    fields.push(`name=$${i++}`); values.push(name.trim())
  }
  if (client_name !== undefined) {
    fields.push(`client_name=$${i++}`); values.push(client_name?.trim() || null)
  }
  if (description !== undefined) {
    fields.push(`description=$${i++}`); values.push(description?.trim() || null)
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.id)

  try {
    const { rows } = await req.db.query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/stats
router.get('/:id/stats', requireTenantAccess, async (req, res) => {
  try {
    // Same fix as GET /:id/health — passed/failed/notRun sourced from real
    // execution history (execution_run_test_cases), not test_cases.status,
    // which execution runs never write to.
    const { rows } = await req.db.query(`
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
router.get('/:id/health', requireTenantAccess, async (req, res) => {
  try {
    const projectId = req.params.id

    const [testCaseRows, bugRows, coverageRows, trendRows, requirementCoverageRows] = await Promise.all([
      req.db.query(`
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
      req.db.query(`
        SELECT severity, COUNT(*)::int AS count
        FROM bugs
        WHERE project_id = $1 AND status = 'open'
        GROUP BY severity
      `, [projectId]),
      req.db.query(`
        SELECT
          COUNT(DISTINCT tc.id)::int AS total,
          COUNT(DISTINCT tc.id) FILTER (WHERE atc.id IS NOT NULL)::int AS automated
        FROM test_cases tc
        LEFT JOIN automated_test_cases atc ON atc.test_case_id = tc.id
        WHERE tc.project_id = $1
      `, [projectId]),
      req.db.query(`
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
      req.db.query(`
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

// POST /projects/:id/members — admin only, grants a client user access to a
// tenant. Membership is control-plane data (it's an access-control decision
// that has to be made BEFORE a tenant DB connection is even opened), so this
// queries tenant_members/users via the control-plane pool, not req.db —
// deliberately no requireTenantAccess here.
router.post('/:id/members', requireRole('admin'), async (req, res) => {
  const { email } = req.body
  if (!email?.trim()) return res.status(400).json({ error: 'Email is required' })

  try {
    const { rows: userRows } = await query('SELECT id FROM users WHERE email=$1', [email.toLowerCase().trim()])
    if (!userRows[0]) return res.status(404).json({ error: 'No user with that email has registered yet' })

    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'client')
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [req.params.id, userRows[0].id]
    )
    res.status(201).json({ added: email })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/members — admin only, lists clients this tenant has been shared with
router.get('/:id/members', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.name
       FROM tenant_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1 AND tm.role = 'client'
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
      `DELETE FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`,
      [req.params.id, req.params.userId]
    )
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
