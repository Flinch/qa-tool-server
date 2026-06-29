import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /projects
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.*,
        COUNT(DISTINCT tc.id)::int AS test_case_count,
        COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'open')::int AS open_bug_count
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id
      LEFT JOIN bugs b ON b.project_id = p.id
      WHERE p.created_by = $1
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `, [req.userId])
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects
router.post('/', async (req, res) => {
  const { name, client_name, description } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })

  try {
    // Upsert user
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
    const { rows } = await query(`SELECT * FROM projects WHERE id=$1 AND created_by=$2`, [req.params.id, req.userId])
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /projects/:id/stats
router.get('/:id/stats', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(DISTINCT tc.id)::int AS "testCases",
        COUNT(tc.id) FILTER (WHERE tc.status = 'pass')::int AS passed,
        COUNT(tc.id) FILTER (WHERE tc.status = 'fail')::int AS failed,
        COUNT(tc.id) FILTER (WHERE tc.status = 'not_run')::int AS "notRun",
        COUNT(b.id) FILTER (WHERE b.status = 'open')::int AS "openBugs"
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id = p.id
      LEFT JOIN bugs b ON b.project_id = p.id
      WHERE p.id = $1 AND p.created_by = $2
    `, [req.params.id, req.userId])
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
