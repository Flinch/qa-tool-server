import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireProjectAccess } from '../middleware/projectAccess.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireProjectAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

// GET /projects/:id/test-cases — staff + read-only clients who are project members
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT tc.*, COUNT(b.id)::int AS bug_count
       FROM test_cases tc
       LEFT JOIN bugs b ON b.test_case_id = tc.id
       WHERE tc.project_id=$1
       GROUP BY tc.id
       ORDER BY tc.created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/', staffOnly, async (req, res) => {
  const { title, type, steps, expected, platform, feature_id } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (!['functional', 'integration', 'e2e'].includes(type)) return res.status(400).json({ error: 'Invalid type' })
  if (platform !== undefined && !['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })

  try {
    if (feature_id) {
      const { rows: fRows } = await query(`SELECT id FROM features WHERE id=$1 AND project_id=$2`, [feature_id, req.params.id])
      if (!fRows[0]) return res.status(400).json({ error: 'Invalid feature' })
    }

    const { rows } = await query(
      `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, created_by, platform, feature_id)
       VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8) RETURNING *`,
      [req.params.id, title.trim(), type, JSON.stringify(steps || []), expected || '', req.userId, platform || 'web', feature_id || null]
    )
    await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])
    res.status(201).json({ ...rows[0], bug_count: 0 })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/:tcId/bugs', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM bugs WHERE test_case_id=$1 ORDER BY created_at DESC`,
      [req.params.tcId]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export async function deleteTestCase(req, res) {
  try {
    const { rowCount } = await query(`DELETE FROM test_cases WHERE id=$1`, [req.params.id])
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

export async function patchTestCase(req, res) {
  const { status, title, type, steps, expected, automationCandidate, automationReasoning, platform, feature_id } = req.body

  const fields = []
  const values = []
  let i = 1

  if (status !== undefined) {
    if (!['not_run', 'pass', 'fail'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    fields.push(`status=$${i++}`); values.push(status)
  }
  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title cannot be empty' })
    fields.push(`title=$${i++}`); values.push(title.trim())
  }
  if (type !== undefined) {
    if (!['functional', 'integration', 'e2e'].includes(type)) return res.status(400).json({ error: 'Invalid type' })
    fields.push(`type=$${i++}`); values.push(type)
  }
  if (steps !== undefined) {
    fields.push(`steps=$${i++}`); values.push(JSON.stringify(steps))
  }
  if (expected !== undefined) {
    fields.push(`expected=$${i++}`); values.push(expected)
  }
  if (automationCandidate !== undefined) {
    fields.push(`automation_candidate=$${i++}`); values.push(!!automationCandidate)
  }
  if (automationReasoning !== undefined) {
    fields.push(`automation_reasoning=$${i++}`); values.push(automationReasoning)
  }
  if (platform !== undefined) {
    if (!['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })
    fields.push(`platform=$${i++}`); values.push(platform)
  }
  if (feature_id !== undefined) {
    fields.push(`feature_id=$${i++}`); values.push(feature_id || null)
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.id)

  try {
    if (feature_id) {
      // No project_id in this route's params (mounted at /api/test-cases/:id) —
      // validate via the test case's own project instead.
      const { rows: fRows } = await query(
        `SELECT f.id FROM features f JOIN test_cases tc ON tc.project_id = f.project_id
         WHERE f.id=$1 AND tc.id=$2`,
        [feature_id, req.params.id]
      )
      if (!fRows[0]) return res.status(400).json({ error: 'Invalid feature' })
    }

    const { rows } = await query(
      `UPDATE test_cases SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
export default router