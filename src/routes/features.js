import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireTenantAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

// GET /projects/:id/features — health rollup per feature. Same
// latest-real-execution-result pattern already used by GET /projects/:id/health
// (test_cases.status is never written to by execution runs, so it can't be
// trusted here either), grouped by feature instead of the whole project.
router.get('/', async (req, res) => {
  try {
    const { rows } = await req.db.query(`
      WITH latest_manual AS (
        SELECT DISTINCT ON (erc.test_case_id) erc.test_case_id, erc.status, erc.executed_at AS at
        FROM execution_run_test_cases erc
        JOIN execution_runs er ON er.id = erc.execution_run_id
        WHERE er.project_id = $1 AND erc.status != 'not_run'
        ORDER BY erc.test_case_id, erc.executed_at DESC NULLS LAST
      ),
      -- Same fix as GET /:id/health — a suite's own real runs never fed this
      -- at all before, only manually-tracked execution_run_test_cases did.
      latest_suite AS (
        SELECT DISTINCT ON (atc.test_case_id) atc.test_case_id,
          CASE trr.status WHEN 'passed' THEN 'pass' WHEN 'failed' THEN 'fail' ELSE 'blocked' END AS status,
          tr.completed_at AS at
        FROM test_run_results trr
        JOIN test_runs tr ON tr.id = trr.test_run_id
        JOIN automated_test_cases atc ON atc.suite_id = tr.suite_id AND atc.title = trr.test_title
        WHERE tr.project_id = $1 AND tr.scope = 'suite' AND atc.test_case_id IS NOT NULL
        ORDER BY atc.test_case_id, tr.completed_at DESC NULLS LAST
      ),
      latest_execution AS (
        SELECT COALESCE(m.test_case_id, su.test_case_id) AS test_case_id,
          CASE
            WHEN m.at IS NULL THEN su.status
            WHEN su.at IS NULL THEN m.status
            WHEN m.at >= su.at THEN m.status
            ELSE su.status
          END AS status
        FROM latest_manual m
        FULL OUTER JOIN latest_suite su ON su.test_case_id = m.test_case_id
      )
      SELECT
        f.id, f.name, f.description,
        COUNT(DISTINCT tc.id)::int AS test_case_count,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'pass')::int AS passed,
        COUNT(DISTINCT tc.id) FILTER (WHERE le.status = 'fail')::int AS failed,
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS open_bug_count
      FROM features f
      LEFT JOIN test_cases tc ON tc.feature_id = f.id AND tc.archived_at IS NULL
      LEFT JOIN latest_execution le ON le.test_case_id = tc.id
      LEFT JOIN bugs b ON b.feature_id = f.id
      WHERE f.project_id = $1
      GROUP BY f.id
      ORDER BY f.name
    `, [req.params.id])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/', staffOnly, async (req, res) => {
  const { name, description } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  try {
    const { rows } = await req.db.query(
      `INSERT INTO features (project_id, name, description, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name.trim(), description || null, req.userId]
    )
    res.status(201).json({ ...rows[0], test_case_count: 0, passed: 0, failed: 0, open_bug_count: 0 })
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A feature with this name already exists' })
    res.status(500).json({ error: e.message })
  }
})

// PATCH/DELETE /projects/:id/features/:featureId — nested under this router
// (not flat /api/features/:id mounts) so requireTenantAccess runs first and
// req.db is resolved before either handler queries anything. Both also
// filter by project_id — see testCases.js's identical PATCH/DELETE comment
// for why that's not redundant yet during Phase A's identity-resolver
// bridge.
router.patch('/:featureId', staffOnly, async (req, res) => {
  const { name, description } = req.body

  const fields = []
  const values = []
  let i = 1

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' })
    fields.push(`name=$${i++}`); values.push(name.trim())
  }
  if (description !== undefined) {
    fields.push(`description=$${i++}`); values.push(description)
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.featureId)
  const featureIdParam = i++
  values.push(req.params.id)
  const projectIdParam = i++

  try {
    const { rows } = await req.db.query(
      `UPDATE features SET ${fields.join(', ')} WHERE id=$${featureIdParam} AND project_id=$${projectIdParam} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A feature with this name already exists' })
    res.status(500).json({ error: e.message })
  }
})

router.delete('/:featureId', staffOnly, async (req, res) => {
  try {
    const { rowCount } = await req.db.query(`DELETE FROM features WHERE id=$1 AND project_id=$2`, [req.params.featureId, req.params.id])
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
