import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { extractDocumentText } from '../lib/extractDocumentText.js'
import { generateTestCasesForRequirements } from '../lib/generateTestCasesFromRequirements.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

// POST /upload — parse a requirements document (paste or file). If the
// project has no active requirements yet, segments the doc and creates them
// directly (Phase 2). If it already has requirements, diffs the new text
// against the current set instead of blindly adding duplicates, and returns
// the diff for review — nothing is written to `requirements` in that case
// until POST /apply-diff confirms it (Phase 3).
router.post('/upload', async (req, res) => {
  const { filename, mimetype, data, text } = req.body
  if (!data && !text?.trim()) return res.status(400).json({ error: 'A file or pasted text is required' })

  try {
    const rawText = data ? await extractDocumentText({ filename, mimetype, data }) : text.trim()
    if (!rawText?.trim()) return res.status(400).json({ error: 'Could not extract any text from that document' })

    const { rows: docRows } = await query(
      `INSERT INTO requirement_documents (project_id, filename, raw_text, uploaded_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, filename || null, rawText, req.userId]
    )
    const doc = docRows[0]

    const { rows: existing } = await query(
      `SELECT r.id, r.title, r.description, COUNT(DISTINCT rtc.test_case_id)::int AS linked_test_case_count
       FROM requirements r
       LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
       WHERE r.project_id=$1 AND r.status='active'
       GROUP BY r.id`,
      [req.params.id]
    )

    if (existing.length === 0) {
      const prompt = `You are a senior QA/product analyst. Given the following requirements document, break it down into a list of discrete, individually testable requirements.

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "title": string — short, specific requirement name
- "description": string — the full requirement detail, rewritten clearly if needed

Rules:
- Split compound requirements into separate items when they describe genuinely different behavior
- Do not invent requirements that aren't actually in the document
- Aim for individually testable units, not a paragraph-by-paragraph copy

Document:
${rawText}`

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      })

      const raw = message.content[0].text.trim()
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
      const parsed = JSON.parse(cleaned)

      const inserted = []
      for (const r of parsed) {
        const { rows } = await query(
          `INSERT INTO requirements (project_id, title, description, document_id, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [req.params.id, r.title, r.description || '', doc.id, req.userId]
        )
        inserted.push({ ...rows[0], linked_test_case_count: 0 })
      }

      return res.status(201).json({ mode: 'created', document: doc, requirements: inserted })
    }

    // Diff mode — no writes to `requirements` here, just classification.
    const currentList = existing.map(r => `[id=${r.id}] Title: ${r.title}\nDescription: ${r.description || '(none)'}`).join('\n\n')

    const diffPrompt = `You are a senior QA/product analyst. Compare an updated requirements document against the current list of tracked requirements for this project, and classify what changed.

Current requirements:
${currentList}

New document:
${rawText}

Return ONLY a valid JSON object with no preamble, no markdown, no explanation, with this exact shape:
{
  "modified": [{"id": 12, "title": "...", "description": "..."}],
  "removed": [13, 15],
  "new": [{"title": "...", "description": "..."}]
}

Rules:
- "modified": existing requirements (use their real id) whose actual meaning or behavior changed based on the new document — title/description are the updated versions. Only mark something modified if the meaning changed, not just wording.
- "removed": ids of existing requirements no longer present in the new document at all.
- "new": requirements described in the new document that don't correspond to any existing one.
- Any existing requirement not mentioned in "modified" or "removed" is assumed unchanged — do not list unchanged ones anywhere.
- Do not invent requirements that aren't actually in the document.`

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: diffPrompt }],
    })

    const raw = message.content[0].text.trim()
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const diffResult = JSON.parse(cleaned)

    const byId = Object.fromEntries(existing.map(r => [r.id, r]))
    const modified = (diffResult.modified || [])
      .filter(m => byId[m.id])
      .map(m => ({ id: m.id, title: m.title, description: m.description || '', old: byId[m.id] }))
    const removed = (diffResult.removed || [])
      .filter(id => byId[id])
      .map(id => byId[id])
    const newItems = diffResult.new || []
    const unchangedCount = existing.length - modified.length - removed.length

    res.status(201).json({
      mode: 'diff',
      document: doc,
      diff: { modified, removed, new: newItems, unchangedCount },
    })
  } catch (e) {
    console.error('Requirement upload error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /apply-diff — commits a user-reviewed diff from POST /upload. Only
// items the user approved should be included; nothing here is inferred.
router.post('/apply-diff', async (req, res) => {
  const { documentId, modified = [], removed = [], added = [] } = req.body

  try {
    const updated = []
    for (const m of modified) {
      const { rows } = await query(
        `UPDATE requirements SET title=$1, description=$2, document_id=$3, updated_at=NOW()
         WHERE id=$4 AND project_id=$5 RETURNING *`,
        [m.title, m.description || '', documentId, m.id, req.params.id]
      )
      if (rows[0]) updated.push(rows[0])
    }

    for (const id of removed) {
      await query(
        `UPDATE requirements SET status='removed', updated_at=NOW() WHERE id=$1 AND project_id=$2`,
        [id, req.params.id]
      )
    }

    const inserted = []
    for (const n of added) {
      const { rows } = await query(
        `INSERT INTO requirements (project_id, title, description, document_id, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, n.title, n.description || '', documentId, req.userId]
      )
      inserted.push({ ...rows[0], linked_test_case_count: 0 })
    }

    res.json({ updated, removedIds: removed, inserted })
  } catch (e) {
    console.error('Requirement apply-diff error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /:reqId/generate-test-case — the only way a single requirement gets
// a test case generated for it. Rejects (400) if it already has one — a
// real server-side gate, not just a hidden button, so a stale page or a
// direct API call can't create a duplicate.
router.post('/:reqId/generate-test-case', async (req, res) => {
  try {
    const { rows: reqRows } = await query(
      `SELECT r.id, r.title, r.description, COUNT(DISTINCT rtc.test_case_id)::int AS linked_test_case_count
       FROM requirements r
       LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
       WHERE r.id=$1 AND r.project_id=$2 AND r.status='active'
       GROUP BY r.id`,
      [req.params.reqId, req.params.id]
    )
    const requirement = reqRows[0]
    if (!requirement) return res.status(404).json({ error: 'Requirement not found' })
    if (requirement.linked_test_case_count > 0) {
      return res.status(400).json({ error: 'This requirement already has a linked test case' })
    }

    const generated = await generateTestCasesForRequirements([requirement])

    const inserted = []
    for (const tc of generated) {
      const { rows } = await query(
        `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', !!tc.automationCandidate, tc.automationReasoning || null, req.userId]
      )
      await query(
        `INSERT INTO requirement_test_cases (requirement_id, test_case_id) VALUES ($1,$2)`,
        [requirement.id, rows[0].id]
      )
      inserted.push({ ...rows[0], bug_count: 0 })
    }

    res.status(201).json({ testCases: inserted, linked_test_case_count: inserted.length })
  } catch (e) {
    console.error('Requirement generate-test-case error:', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /generate-test-cases — bulk: every active requirement with zero
// linked test cases, in one batched AI call.
router.post('/generate-test-cases', async (req, res) => {
  try {
    const { rows: uncovered } = await query(
      `SELECT r.id, r.title, r.description
       FROM requirements r
       LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
       WHERE r.project_id=$1 AND r.status='active'
       GROUP BY r.id
       HAVING COUNT(DISTINCT rtc.test_case_id) = 0`,
      [req.params.id]
    )
    if (uncovered.length === 0) {
      return res.status(400).json({ error: 'Every requirement already has a linked test case' })
    }

    const generated = await generateTestCasesForRequirements(uncovered)

    const byRequirement = {}
    for (const tc of generated) {
      const { rows } = await query(
        `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', !!tc.automationCandidate, tc.automationReasoning || null, req.userId]
      )
      await query(
        `INSERT INTO requirement_test_cases (requirement_id, test_case_id) VALUES ($1,$2)`,
        [tc.requirementId, rows[0].id]
      )
      ;(byRequirement[tc.requirementId] ||= []).push({ ...rows[0], bug_count: 0 })
    }

    const summary = uncovered.map(r => ({
      requirementId: r.id,
      testCases: byRequirement[r.id] || [],
    }))

    res.status(201).json({ generated: summary, totalTestCases: generated.length })
  } catch (e) {
    console.error('Requirement bulk generate-test-cases error:', e)
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
