import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { extractDocumentText } from '../lib/extractDocumentText.js'

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

// POST /upload — parse a requirements document (paste or file) into
// discrete requirements. Phase 2 only: this always creates new rows, with
// no diffing against what's already there — diffing a re-upload against the
// existing set is Phase 3, not built yet.
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

    res.status(201).json({ document: doc, requirements: inserted })
  } catch (e) {
    console.error('Requirement upload error:', e)
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
