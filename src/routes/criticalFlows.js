import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'
import { reviewCriticalFlows } from '../lib/generateCriticalFlows.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireTenantAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

// POST /projects/:id/critical-flows/review — reasons over the whole active
// requirement set at once (not per-requirement) to propose the small,
// curated set of critical end-to-end flows, diffed against whatever's
// already tracked. No writes — mirrors POST /requirements/upload's
// return-a-diff-for-review shape exactly.
router.post('/review', staffOnly, async (req, res) => {
  try {
    const { rows: requirements } = await req.db.query(
      `SELECT id, title, description, platform FROM requirements WHERE project_id=$1 AND status='active' ORDER BY id`,
      [req.params.id]
    )

    const { rows: existingFlows } = await req.db.query(
      `SELECT tc.id, tc.title, tc.steps, tc.expected, tc.platform,
         COALESCE(array_agg(fr.requirement_id) FILTER (WHERE fr.requirement_id IS NOT NULL), '{}') AS requirement_ids
       FROM test_cases tc
       LEFT JOIN flow_requirements fr ON fr.test_case_id = tc.id
       WHERE tc.project_id=$1 AND tc.type='e2e' AND tc.automation_candidate=true
       GROUP BY tc.id
       ORDER BY tc.id`,
      [req.params.id]
    )

    const { rows: projectRows } = await req.db.query(
      `SELECT name, client_name, description FROM projects WHERE id=$1`,
      [req.params.id]
    )

    const flowsById = new Map(existingFlows.map(f => [f.id, { ...f, requirementIds: f.requirement_ids }]))

    const rawDiff = await reviewCriticalFlows({
      requirements,
      existingFlows: [...flowsById.values()],
      project: projectRows[0] || {},
    })

    // The AI returns "removed" as bare ids (same shape requirements.js's own
    // diff prompt uses) — resolve each back to the full flow object here so
    // the review UI has a title/steps to actually show, same treatment
    // requirements.js's own upload route already gives its removed array.
    const diff = {
      modified: rawDiff.modified || [],
      new: rawDiff.new || [],
      removed: (rawDiff.removed || []).filter(id => flowsById.has(id)).map(id => flowsById.get(id)),
    }

    const unchangedCount = existingFlows.length - diff.modified.length - diff.removed.length
    res.json({ diff, unchangedCount })
  } catch (e) {
    console.error('Critical flows review error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/critical-flows/apply — commits a user-reviewed diff
// from POST /review. Transactional (unlike most routes in this app): a
// flow's test_cases row and its flow_requirements links have to land
// together, same reasoning as testCases.js's /combine/apply.
router.post('/apply', staffOnly, async (req, res) => {
  const { modified = [], removed = [], new: added = [] } = req.body

  const client = await req.db.connect()
  try {
    await client.query('BEGIN')

    // Never trust requirementIds from the request body blindly — filter
    // every reference down to requirements that are real, active, and
    // actually belong to this project. Silently dropped, not a hard
    // failure: one stray id shouldn't block the rest of a genuinely good
    // diff from applying.
    const { rows: validReqRows } = await client.query(
      `SELECT id FROM requirements WHERE project_id=$1 AND status='active'`,
      [req.params.id]
    )
    const validReqIds = new Set(validReqRows.map(r => r.id))
    const sanitizeReqIds = (ids) => (ids || []).filter(id => validReqIds.has(id))

    const modifiedIds = []
    for (const m of modified) {
      const { rows } = await client.query(
        `UPDATE test_cases SET title=$1, steps=$2, expected=$3, platform=$4, automation_reasoning=$5, updated_at=NOW()
         WHERE id=$6 AND project_id=$7 AND type='e2e' RETURNING id`,
        [m.title, JSON.stringify(m.steps || []), m.expected || '', m.platform || 'web', m.reasoning || null, m.id, req.params.id]
      )
      if (!rows[0]) continue
      modifiedIds.push(rows[0].id)

      await client.query(`DELETE FROM flow_requirements WHERE test_case_id=$1`, [rows[0].id])
      for (const reqId of sanitizeReqIds(m.requirementIds)) {
        await client.query(
          `INSERT INTO flow_requirements (requirement_id, test_case_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [reqId, rows[0].id]
        )
      }
    }

    // Demoted, not deleted — a flow that no longer represents a critical
    // journey may still have real automation/bug history attached, and it
    // remains a perfectly valid e2e test case, just no longer flagged as an
    // automation candidate. Its flow_requirements links are left as-is.
    const removedIds = []
    for (const id of removed) {
      const { rows } = await client.query(
        `UPDATE test_cases SET automation_candidate=false, updated_at=NOW()
         WHERE id=$1 AND project_id=$2 AND type='e2e' RETURNING id`,
        [id, req.params.id]
      )
      if (rows[0]) removedIds.push(rows[0].id)
    }

    const inserted = []
    for (const n of added) {
      const { rows } = await client.query(
        `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by, platform)
         VALUES ($1,$2,'e2e',$3,$4,true,$5,$6,$7) RETURNING *`,
        [req.params.id, n.title, JSON.stringify(n.steps || []), n.expected || '', n.reasoning || null, req.userId, n.platform || 'web']
      )
      const flow = rows[0]
      for (const reqId of sanitizeReqIds(n.requirementIds)) {
        await client.query(
          `INSERT INTO flow_requirements (requirement_id, test_case_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [reqId, flow.id]
        )
      }
      inserted.push(flow)
    }

    await client.query('COMMIT')
    res.json({ modifiedIds, removedIds, inserted })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('Critical flows apply error:', e)
    res.status(500).json({ error: e.message })
  } finally {
    client.release()
  }
})

export default router
