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
      WHERE p.id = $1
    `, [req.params.id])
    res.json(rows[0])
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

export default router