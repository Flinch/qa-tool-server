import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(DISTINCT p.id)::int AS projects,
        COUNT(DISTINCT tc.id)::int AS "testCases",
        COUNT(DISTINCT tc.id) FILTER (WHERE tc.status = 'pass')::int AS passed,
        COUNT(DISTINCT tc.id) FILTER (WHERE tc.status = 'fail')::int AS failed,
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id
      LEFT JOIN bugs b ON b.project_id = p.id
    `)
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router