import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(DISTINCT p.id)::int AS projects,
        COUNT(DISTINCT tc.id)::int AS "testCases",
        COUNT(tc.id) FILTER (WHERE tc.status = 'pass')::int AS passed,
        COUNT(tc.id) FILTER (WHERE tc.status = 'fail')::int AS failed,
        COUNT(b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id
      LEFT JOIN bugs b ON b.project_id = p.id
      WHERE p.created_by = $1
    `, [req.userId])
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
