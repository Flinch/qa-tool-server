import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

// GET /projects/:id/bugs
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM bugs WHERE project_id=$1 ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/bugs
router.post('/', async (req, res) => {
  const { title, severity, steps_to_reproduce, expected, actual, notes, test_case_id } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

  try {
    const { rows } = await query(
      `INSERT INTO bugs (project_id, test_case_id, title, severity, steps_to_reproduce, expected, actual, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, test_case_id || null, title.trim(), severity || 'medium',
       steps_to_reproduce || null, expected || null, actual || null, notes || null, req.userId]
    )
    await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])
    res.status(201).json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /bugs/:id — mounted at root in index.js
export async function patchBug(req, res) {
  const { status } = req.body
  const allowed = ['open', 'in_progress', 'resolved']
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' })

  try {
    const { rows } = await query(
      `UPDATE bugs SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

export default router
