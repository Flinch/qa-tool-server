import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

router.get('/', async (req, res) => {
  try {
    // passed/failed sourced from real execution history, not test_cases.status
    // — see the identical fix (and the reasoning for it) on
    // GET /projects/:id/health in projects.js. Not scoping latest_execution
    // by project here since this is a global, cross-project aggregate;
    // test_case_id is already project-scoped via the tc join below, so no
    // cross-project leakage.
    const { rows } = await query(`
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
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id
      LEFT JOIN latest_execution le ON le.test_case_id = tc.id
      LEFT JOIN bugs b ON b.project_id = p.id
    `)
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router