import { Router } from 'express'
import { query, pool } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireProjectAccess } from '../middleware/projectAccess.js'
import { combineTestCases } from '../lib/combineTestCases.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireProjectAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

// GET /projects/:id/test-cases — staff + read-only clients who are project members
router.get('/', async (req, res) => {
  try {
    // is_automated: does this TC actually have real generated automation
    // (an automated_test_cases roster row resolved back to it), as opposed
    // to merely being flagged automation_candidate — "candidate" just means
    // an engineer/AI thinks it's a good fit; "automated" means it actually
    // has committed code. Same origin='generated' signal already used
    // everywhere else this session (webhooks.js roster tracking, The Lab).
    const { rows } = await query(
      `SELECT tc.*, COUNT(b.id)::int AS bug_count,
         EXISTS (
           SELECT 1 FROM automated_test_cases atc
           WHERE atc.test_case_id = tc.id AND atc.origin = 'generated'
         ) AS is_automated
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

// POST /projects/:id/test-cases/combine — returns an AI-merged draft for
// review. Writes nothing; mirrors the "return a diff, don't write" shape
// already used by POST /requirements/upload.
router.post('/combine', staffOnly, async (req, res) => {
  const { test_case_ids } = req.body
  if (!Array.isArray(test_case_ids) || test_case_ids.length < 2) {
    return res.status(400).json({ error: 'At least 2 test_case_ids are required' })
  }

  try {
    const { rows: sourceTestCases } = await query(
      `SELECT * FROM test_cases WHERE project_id=$1 AND id = ANY($2::int[])`,
      [req.params.id, test_case_ids]
    )
    if (sourceTestCases.length !== test_case_ids.length) {
      return res.status(400).json({ error: 'One or more test cases were not found in this project' })
    }
    const platforms = new Set(sourceTestCases.map(tc => tc.platform || 'web'))
    if (platforms.size > 1) {
      return res.status(400).json({ error: 'Test cases must share the same platform to combine (a web and a mobile flow have nothing to merge)' })
    }

    const draft = await combineTestCases(sourceTestCases)
    res.json({ draft, sourceTestCases })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/test-cases/combine/apply — creates the reviewed/edited
// combined test case, transfers requirement and bug links from the
// originals, then deletes the originals. requirement_test_cases links are
// re-pointed BEFORE the delete since that table is ON DELETE CASCADE (see
// migrate.js) and would otherwise silently lose this coverage; bugs.test_case_id
// is ON DELETE SET NULL, so it's re-pointed first too rather than left to null out.
router.post('/combine/apply', staffOnly, async (req, res) => {
  const { test_case_ids, combined } = req.body
  if (!Array.isArray(test_case_ids) || test_case_ids.length < 2) {
    return res.status(400).json({ error: 'At least 2 test_case_ids are required' })
  }
  const { title, type, steps, expected, platform, automation_candidate, automation_reasoning, feature_id } = combined || {}
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (!['functional', 'integration', 'e2e'].includes(type)) return res.status(400).json({ error: 'Invalid type' })
  if (!['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })

  // Transactional, unlike the rest of this file's sequential query() calls:
  // insert + two relation-transfers + delete is one logical unit here, and a
  // failure partway through (confirmed for real during testing — a bug in
  // the requirement-transfer query left an orphaned new test case with the
  // originals never cleaned up) must not leave that half-applied.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: sourceTestCases } = await client.query(
      `SELECT id FROM test_cases WHERE project_id=$1 AND id = ANY($2::int[])`,
      [req.params.id, test_case_ids]
    )
    if (sourceTestCases.length !== test_case_ids.length) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'One or more test cases were not found in this project' })
    }

    if (feature_id) {
      const { rows: fRows } = await client.query(`SELECT id FROM features WHERE id=$1 AND project_id=$2`, [feature_id, req.params.id])
      if (!fRows[0]) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Invalid feature' })
      }
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by, platform, feature_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.params.id, title.trim(), type, JSON.stringify(steps || []), expected || '', !!automation_candidate, automation_reasoning || null, req.userId, platform, feature_id || null]
    )
    const newId = inserted[0].id

    await client.query(
      `INSERT INTO requirement_test_cases (requirement_id, test_case_id)
       SELECT DISTINCT requirement_id, $1::int FROM requirement_test_cases WHERE test_case_id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [newId, test_case_ids]
    )
    await client.query(`UPDATE bugs SET test_case_id=$1 WHERE test_case_id = ANY($2::int[])`, [newId, test_case_ids])
    await client.query(`DELETE FROM test_cases WHERE id = ANY($1::int[])`, [test_case_ids])
    await client.query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])

    const { rows: result } = await client.query(
      `SELECT tc.*, COUNT(b.id)::int AS bug_count
       FROM test_cases tc LEFT JOIN bugs b ON b.test_case_id = tc.id
       WHERE tc.id=$1 GROUP BY tc.id`,
      [newId]
    )
    await client.query('COMMIT')
    res.status(201).json(result[0])
  } catch (e) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
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