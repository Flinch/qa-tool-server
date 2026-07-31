import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'
import { extractDocumentText } from '../lib/extractDocumentText.js'
import { generateTestCasesForRequirements } from '../lib/generateTestCasesFromRequirements.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireTenantAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Lookup-or-create by name — the AI upload flow proposes a feature_name
// string (user-editable in review, not a numeric id), so this resolves it to
// a real feature row, reusing an existing one under the same
// UNIQUE(project_id, name) constraint rather than creating a duplicate.
// Blank/omitted name just means no feature — not required here the way it is
// for manual bug creation.
async function resolveFeatureId(db, projectId, name, userId) {
  const trimmed = name?.trim()
  if (!trimmed) return null
  await db.query(
    `INSERT INTO features (project_id, name, created_by) VALUES ($1,$2,$3)
     ON CONFLICT (project_id, name) DO NOTHING`,
    [projectId, trimmed, userId]
  )
  const { rows } = await db.query(`SELECT id FROM features WHERE project_id=$1 AND name=$2`, [projectId, trimmed])
  return rows[0]?.id || null
}

// GET /projects/:id/requirements — staff + read-only clients who are project members
router.get('/', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT r.*, COUNT(DISTINCT rtc.test_case_id)::int AS linked_test_case_count
       FROM requirements r
       LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
       WHERE r.project_id=$1 AND r.status='active'
       GROUP BY r.id
       ORDER BY r.created_at DESC`,
      [req.params.id]
    )
    // ambiguity_flag/estimated_effort are AI-assessment output (Requirements
    // Intelligence) — staff-only, stripped for clients same as
    // automation.js's review_status/origin.
    res.json(req.userRole === 'client' ? rows.map(({ ambiguity_flag, estimated_effort, ...rest }) => rest) : rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/', staffOnly, async (req, res) => {
  const { title, description, platform, feature_id } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (platform !== undefined && !['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })

  try {
    if (feature_id) {
      const { rows: fRows } = await req.db.query(`SELECT id FROM features WHERE id=$1 AND project_id=$2`, [feature_id, req.params.id])
      if (!fRows[0]) return res.status(400).json({ error: 'Invalid feature' })
    }

    const { rows } = await req.db.query(
      `INSERT INTO requirements (project_id, title, description, created_by, platform, feature_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, title.trim(), description || '', req.userId, platform || 'web', feature_id || null]
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
router.post('/upload', staffOnly, async (req, res) => {
  const { filename, mimetype, data, text, platform } = req.body
  if (!data && !text?.trim()) return res.status(400).json({ error: 'A file or pasted text is required' })
  if (platform !== undefined && !['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })
  const uploadPlatform = platform || 'web'

  try {
    const rawText = data ? await extractDocumentText({ filename, mimetype, data }) : text.trim()
    if (!rawText?.trim()) return res.status(400).json({ error: 'Could not extract any text from that document' })

    const { rows: docRows } = await req.db.query(
      `INSERT INTO requirement_documents (project_id, filename, raw_text, uploaded_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, filename || null, rawText, req.userId]
    )
    const doc = docRows[0]

    const { rows: existing } = await req.db.query(
      `SELECT r.id, r.title, r.description, COUNT(DISTINCT rtc.test_case_id)::int AS linked_test_case_count
       FROM requirements r
       LEFT JOIN requirement_test_cases rtc ON rtc.requirement_id = r.id
       WHERE r.project_id=$1 AND r.status='active'
       GROUP BY r.id`,
      [req.params.id]
    )

    // Existing feature names for this project, passed to the AI as context so
    // it reuses a real feature instead of minting a near-duplicate when a
    // requirement clearly belongs to one already tracked.
    const { rows: existingFeatures } = await req.db.query(
      `SELECT name FROM features WHERE project_id=$1 ORDER BY name`,
      [req.params.id]
    )
    const featureContext = existingFeatures.length > 0
      ? existingFeatures.map(f => f.name).join(', ')
      : '(none yet — propose new ones)'

    if (existing.length === 0) {
      // No writes here either, same as diff mode below — the AI's proposed
      // requirements AND its suggested feature per requirement are both
      // reviewed and editable before POST /apply-diff commits anything.
      const prompt = `You are a senior QA/product analyst. Given the following requirements document, break it down into a list of discrete, individually testable requirements, and group them into a small number of coherent product features.

Existing features already tracked for this project (reuse one of these names when a requirement clearly belongs to it, rather than inventing a near-duplicate): ${featureContext}

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "title": string — short, specific requirement name
- "description": string — the full requirement detail, rewritten clearly if needed
- "feature_name": string — a short, specific feature/module name this requirement belongs to (reuse an existing one above when it fits, otherwise propose a new concise name)
- "ambiguity_flag": string or null — a short (one sentence) reason this requirement is ambiguous or missing acceptance criteria (e.g. "no defined error message" or "'quickly' is not a measurable threshold"), or null if it's clear and testable as written
- "estimated_effort": "S", "M", or "L" — rough testing effort: S = a single straightforward check, M = a few related scenarios/edge cases, L = a multi-step flow or several distinct edge cases to cover

Rules:
- Split compound requirements into separate items when they describe genuinely different behavior
- Do not invent requirements that aren't actually in the document
- Aim for individually testable units, not a paragraph-by-paragraph copy
- Keep the total number of distinct feature_name values small and coherent — group related requirements under the same feature rather than creating a new one for each
- Only set ambiguity_flag when there's a genuine, specific gap — not for stylistic nitpicks

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

      const newItems = parsed.map(r => ({
        title: r.title, description: r.description || '', feature_name: r.feature_name || '',
        ambiguity_flag: r.ambiguity_flag || null,
        estimated_effort: ['S', 'M', 'L'].includes(r.estimated_effort) ? r.estimated_effort : null,
      }))

      return res.status(201).json({
        mode: 'created',
        document: doc,
        diff: { modified: [], removed: [], new: newItems, unchangedCount: 0 },
      })
    }

    // Diff mode — no writes to `requirements` here, just classification.
    const currentList = existing.map(r => `[id=${r.id}] Title: ${r.title}\nDescription: ${r.description || '(none)'}`).join('\n\n')

    const diffPrompt = `You are a senior QA/product analyst. Compare an updated requirements document against the current list of tracked requirements for this project, and classify what changed.

Current requirements:
${currentList}

New document:
${rawText}

Existing features already tracked for this project (reuse one of these names for a new requirement when it clearly belongs to it, rather than inventing a near-duplicate): ${featureContext}

Return ONLY a valid JSON object with no preamble, no markdown, no explanation, with this exact shape:
{
  "modified": [{"id": 12, "title": "...", "description": "...", "ambiguity_flag": null, "estimated_effort": "M"}],
  "removed": [13, 15],
  "new": [{"title": "...", "description": "...", "feature_name": "...", "ambiguity_flag": null, "estimated_effort": "S"}]
}

Rules:
- "modified": existing requirements (use their real id) whose actual meaning or behavior changed based on the new document — title/description are the updated versions. Only mark something modified if the meaning changed, not just wording. Do not add "feature_name" to modified items — they keep whatever feature they already have.
- "removed": ids of existing requirements no longer present in the new document at all.
- "new": requirements described in the new document that don't correspond to any existing one. Each needs a "feature_name" — a short feature/module name (reuse an existing one above when it fits, otherwise propose a concise new one). Keep the total number of distinct feature_name values small and coherent.
- Any existing requirement not mentioned in "modified" or "removed" is assumed unchanged — do not list unchanged ones anywhere.
- Do not invent requirements that aren't actually in the document.
- Every "modified" and "new" item needs "ambiguity_flag" (a short one-sentence reason it's ambiguous or missing acceptance criteria, or null if clear and testable) and "estimated_effort" ("S"/"M"/"L" testing effort). Only set ambiguity_flag for a genuine, specific gap, not stylistic nitpicks.`

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: diffPrompt }],
    })

    const raw = message.content[0].text.trim()
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const diffResult = JSON.parse(cleaned)

    const sanitizeEffort = (e) => ['S', 'M', 'L'].includes(e) ? e : null

    const byId = Object.fromEntries(existing.map(r => [r.id, r]))
    const modified = (diffResult.modified || [])
      .filter(m => byId[m.id])
      .map(m => ({
        id: m.id, title: m.title, description: m.description || '', old: byId[m.id],
        ambiguity_flag: m.ambiguity_flag || null, estimated_effort: sanitizeEffort(m.estimated_effort),
      }))
    const removed = (diffResult.removed || [])
      .filter(id => byId[id])
      .map(id => byId[id])
    const newItems = (diffResult.new || []).map(n => ({
      ...n,
      ambiguity_flag: n.ambiguity_flag || null,
      estimated_effort: sanitizeEffort(n.estimated_effort),
    }))
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
router.post('/apply-diff', staffOnly, async (req, res) => {
  const { documentId, modified = [], removed = [], added = [], platform } = req.body
  if (platform !== undefined && !['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })

  const sanitizeEffort = (e) => ['S', 'M', 'L'].includes(e) ? e : null

  try {
    const updated = []
    for (const m of modified) {
      const { rows } = await req.db.query(
        `UPDATE requirements SET title=$1, description=$2, document_id=$3, ambiguity_flag=$4, estimated_effort=$5, updated_at=NOW()
         WHERE id=$6 AND project_id=$7 RETURNING *`,
        [m.title, m.description || '', documentId, m.ambiguity_flag || null, sanitizeEffort(m.estimated_effort), m.id, req.params.id]
      )
      if (rows[0]) updated.push(rows[0])
    }

    for (const id of removed) {
      await req.db.query(
        `UPDATE requirements SET status='removed', updated_at=NOW() WHERE id=$1 AND project_id=$2`,
        [id, req.params.id]
      )
    }

    const inserted = []
    for (const n of added) {
      const featureId = await resolveFeatureId(req.db, req.params.id, n.feature_name, req.userId)
      const { rows } = await req.db.query(
        `INSERT INTO requirements (project_id, title, description, document_id, created_by, platform, feature_id, ambiguity_flag, estimated_effort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.params.id, n.title, n.description || '', documentId, req.userId, platform || 'web', featureId, n.ambiguity_flag || null, sanitizeEffort(n.estimated_effort)]
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
router.post('/:reqId/generate-test-case', staffOnly, async (req, res) => {
  try {
    const { rows: reqRows } = await req.db.query(
      `SELECT r.id, r.title, r.description, r.platform, r.feature_id, COUNT(DISTINCT rtc.test_case_id)::int AS linked_test_case_count
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
      const { rows } = await req.db.query(
        `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by, platform, feature_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', !!tc.automationCandidate, tc.automationReasoning || null, req.userId, requirement.platform, requirement.feature_id]
      )
      await req.db.query(
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
router.post('/generate-test-cases', staffOnly, async (req, res) => {
  try {
    const { rows: uncovered } = await req.db.query(
      `SELECT r.id, r.title, r.description, r.platform, r.feature_id
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
    const platformByRequirement = Object.fromEntries(uncovered.map(r => [r.id, r.platform]))
    const featureByRequirement = Object.fromEntries(uncovered.map(r => [r.id, r.feature_id]))

    const byRequirement = {}
    for (const tc of generated) {
      const { rows } = await req.db.query(
        `INSERT INTO test_cases (project_id, title, type, steps, expected, automation_candidate, automation_reasoning, created_by, platform, feature_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.params.id, tc.title, tc.type, JSON.stringify(tc.steps || []), tc.expected || '', !!tc.automationCandidate, tc.automationReasoning || null, req.userId, platformByRequirement[tc.requirementId] || 'web', featureByRequirement[tc.requirementId] || null]
      )
      await req.db.query(
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
    const { rows } = await req.db.query(
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

router.post('/:reqId/test-cases', staffOnly, async (req, res) => {
  const { test_case_ids } = req.body
  if (!Array.isArray(test_case_ids) || test_case_ids.length === 0) {
    return res.status(400).json({ error: 'test_case_ids is required' })
  }

  try {
    // Server-side half of the platform fix — LinkTestCasesModal already
    // filters candidates client-side, but never trust the client alone: a
    // stale page or a direct API call could still try to cross-link.
    const { rows: reqRows } = await req.db.query(
      `SELECT platform FROM requirements WHERE id=$1 AND project_id=$2`,
      [req.params.reqId, req.params.id]
    )
    if (!reqRows[0]) return res.status(404).json({ error: 'Requirement not found' })
    const { rows: tcRows } = await req.db.query(
      `SELECT id FROM test_cases WHERE project_id=$1 AND id = ANY($2::int[]) AND platform = $3`,
      [req.params.id, test_case_ids, reqRows[0].platform]
    )
    if (tcRows.length !== test_case_ids.length) {
      const validIds = new Set(tcRows.map(r => r.id))
      const rejected = test_case_ids.filter(id => !validIds.has(id))
      return res.status(400).json({ error: `Test cases not found or not "${reqRows[0].platform}" platform: ${rejected.join(', ')}` })
    }

    for (const tcId of test_case_ids) {
      await req.db.query(
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

router.delete('/:reqId/test-cases/:tcId', staffOnly, async (req, res) => {
  try {
    await req.db.query(
      `DELETE FROM requirement_test_cases WHERE requirement_id=$1 AND test_case_id=$2`,
      [req.params.reqId, req.params.tcId]
    )
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /projects/:id/requirements/:reqId — nested under this router (not a
// flat /api/requirements/:id mount) specifically so requireTenantAccess runs
// first and req.db is resolved before this handler ever queries anything.
// Also filters by project_id — see testCases.js's identical PATCH/DELETE
// comment for why that's not redundant yet during Phase A's identity-
// resolver bridge.
router.patch('/:reqId', staffOnly, async (req, res) => {
  const { title, description, status, platform, feature_id } = req.body

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
  if (platform !== undefined) {
    if (!['web', 'mobile'].includes(platform)) return res.status(400).json({ error: 'Invalid platform' })
    fields.push(`platform=$${i++}`); values.push(platform)
  }
  if (feature_id !== undefined) {
    fields.push(`feature_id=$${i++}`); values.push(feature_id || null)
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.reqId)
  const reqIdParam = i++
  values.push(req.params.id)
  const projectIdParam = i++

  try {
    if (feature_id) {
      const { rows: fRows } = await req.db.query(
        `SELECT f.id FROM features f JOIN requirements r ON r.project_id = f.project_id
         WHERE f.id=$1 AND r.id=$2`,
        [feature_id, req.params.reqId]
      )
      if (!fRows[0]) return res.status(400).json({ error: 'Invalid feature' })
    }

    const { rows } = await req.db.query(
      `UPDATE requirements SET ${fields.join(', ')} WHERE id=$${reqIdParam} AND project_id=$${projectIdParam} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
