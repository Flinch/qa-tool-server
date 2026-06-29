import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '../db/pool.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// GET /projects/:id/test-cases
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM test_cases WHERE project_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/test-cases/generate
router.post('/generate', async (req, res) => {
  const { requirements } = req.body
  if (!requirements?.trim()) return res.status(400).json({ error: 'Requirements are required' })

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a senior QA engineer. Given the following requirements, generate comprehensive test cases.

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "title": string — clear, specific test case name
- "type": one of "functional" | "integration" | "e2e"
- "steps": array of strings — numbered steps to execute the test
- "expected": string — the expected result

Generate a mix of types. Cover happy paths, edge cases, and error conditions. Aim for 8-15 test cases.

Requirements:
${requirements}`
      }]
    })

    const raw = message.content[0].text.trim()
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const generated = JSON.parse(cleaned)

    // Bulk insert
    const inserted = []
    for (const tc of generated) {
      const { rows } = await query(
        `INSERT INTO test_cases (project_id, title, type, steps, expected, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', req.userId]
      )
      inserted.push(rows[0])
    }

    // Bump project updated_at
    await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])

    res.status(201).json(inserted)
  } catch (e) {
    console.error('Generation error:', e)
    res.status(500).json({ error: e.message })
  }
})

// PATCH /test-cases/:id (status update) — mounted at root level in index.js
export async function patchTestCase(req, res) {
  const { status } = req.body
  const allowed = ['not_run', 'pass', 'fail']
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' })

  try {
    const { rows } = await query(
      `UPDATE test_cases SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

export default router
