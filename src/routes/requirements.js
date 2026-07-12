import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT r.*, COUNT(DISTINCT rtc.test_case_id)::int AS linked_test_case_count
       FROM requirements r
       LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
       WHERE r.project_id=$1 AND r.status='active'
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/', async (req, res) => {
  const { title, description } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

  try {
    const { rows } = await query(
      `INSERT INTO requirements (project_id, title, description, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, title.trim(), description || '', req.userId]
    )
    res.status(201).json({ ...rows[0], linked_test_case_count: 0 })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/:reqId/test-cases', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tc.* FROM test_cases tc
       JOIN requirement_test_cases rtc ON rtc.test_case_id = tc.id
       WHERE rtc.requirement_id=$1
       ORDER BY tc.created_at DESC`,
      [req.params.reqId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/:reqId/test-cases', async (req, res) => {
  const { test_case_ids } = req.body
  if (!Array.isArray(test_case_ids) || test_case_ids.length === 0) {
    return res.status(400).json({ error: 'test_case_ids is required' })
  }

  try {
    for (const tcId of test_case_ids) {
      await query(
        `INSERT INTO requirement_test_cases (requirement_id, test_case_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.reqId, tcId]
      )
    }
    res.status(201).json({ linked: test_case_ids.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.delete('/:reqId/test-cases/:tcId', async (req, res) => {
  try {
    await query(
      `DELETE FROM requirement_test_cases WHERE requirement_id=$1 AND test_case_id=$2`,
      [req.params.reqId, req.params.tcId]
    )
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export async function patchRequirement(req, res) {
  const { title, description, status } = req.body

  const fields = []
  const values = []
  let i = 1

  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title cannot be empty' })
    fields.push(`title=$${i++}`); values.push(title.trim())
  }
  if (description !== undefined) {
    fields.push(`description=$${i++}`); values.push(description)
  }
  if (status !== undefined) {
    if (!['active', 'removed'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    fields.push(`status=$${i++}`); values.push(status)
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.id)

  try {
    const { rows } = await query(
      `UPDATE requirements SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

export default router
