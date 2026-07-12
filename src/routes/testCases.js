import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { query, pool } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireRole('qa_engineer', 'admin'))

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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

router.post('/', async (req, res) => {
  const { title, type, steps, expected } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (!['functional', 'integration', 'e2e'].includes(type)) return res.status(400).json({ error: 'Invalid type' })

  try {
    const { rows } = await query(
      `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, created_by)
       VALUES ($1,$2,$3,$4,$5,false,$6) RETURNING *`,
      [req.params.id, title.trim(), type, JSON.stringify(steps || []), expected || '', req.userId]
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

router.post('/generate', async (req, res) => {
  const { requirements, mode = 'mvp', replace = false } = req.body
  if (!requirements?.trim()) return res.status(400).json({ error: 'Requirements are required' })

  const automationGuidance = `- "automationCandidate": boolean — true if this test is a good candidate for test automation
- "automationReasoning": string — one short sentence explaining the automationCandidate call

Guidance for automationCandidate: mark true when the test has deterministic, scriptable steps and a clear pass/fail assertion — e.g. form submission, API/data validation, CRUD flows, navigation, repeated regression checks. Mark false when the test relies on subjective human judgment — e.g. visual/layout review, usability or copy review, CAPTCHA, one-off exploratory testing, or steps needing something automation can't easily do (email/SMS retrieval, third-party approvals, physical devices).`

  const mvpPrompt = `You are a senior QA engineer. Given the following requirements, generate a focused MVP test suite.

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "title": string — clear, specific test case name
- "type": one of "functional" | "integration" | "e2e"
- "steps": array of strings — one action per step, in order. Do NOT prefix each string with a number or "Step N:" — the UI renders these in a numbered list already
- "expected": string — the expected result
${automationGuidance}

Rules for MVP mode:
- Cover the core happy path for each requirement
- Include 1-2 edge cases or error conditions total
- Aim for 4-8 test cases maximum
- Prioritize what would catch the most critical bugs
- No redundant or overlapping tests

Requirements:
${requirements}`

  const comprehensivePrompt = `You are a senior QA engineer. Given the following requirements, generate a comprehensive test suite.

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "title": string — clear, specific test case name
- "type": one of "functional" | "integration" | "e2e"
- "steps": array of strings — one action per step, in order. Do NOT prefix each string with a number or "Step N:" — the UI renders these in a numbered list already
- "expected": string — the expected result
${automationGuidance}

Cover happy paths, edge cases, error conditions, boundary values, and integration points. Aim for 12-20 test cases.

Requirements:
${requirements}`

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: mode === 'mvp' ? 2000 : 4000,
      messages: [{ role: 'user', content: mode === 'mvp' ? mvpPrompt : comprehensivePrompt }]
    })

    const raw = message.content[0].text.trim()
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const generated = JSON.parse(cleaned)

    // Parsing happens before any DB mutation either way, so a bad AI
    // response never touches existing data. Replace mode additionally needs
    // real transactional atomicity: the delete-then-insert has to be
    // all-or-nothing, or a mid-loop failure would leave the project with no
    // test cases at all — an ordinary loop of independent `query()` calls
    // (each its own connection) can't guarantee that.
    const inserted = []
    if (replace) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`DELETE FROM test_cases WHERE project_id=$1`, [req.params.id])
        for (const tc of generated) {
          const { rows } = await client.query(
            `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', !!tc.automationCandidate, tc.automationReasoning || null, req.userId]
          )
          inserted.push({ ...rows[0], bug_count: 0 })
        }
        await client.query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])
        await client.query('COMMIT')
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    } else {
      for (const tc of generated) {
        const { rows } = await query(
          `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', !!tc.automationCandidate, tc.automationReasoning || null, req.userId]
        )
        inserted.push({ ...rows[0], bug_count: 0 })
      }
      await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])
    }

    res.status(201).json(inserted)
  } catch (e) {
    console.error('Generation error:', e)
    res.status(500).json({ error: e.message })
  }
})

export async function patchTestCase(req, res) {
  const { status, title, type, steps, expected, automationCandidate, automationReasoning } = req.body

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

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.id)

  try {
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