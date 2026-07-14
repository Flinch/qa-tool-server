import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireProjectAccess } from '../middleware/projectAccess.js'
import { JiraError, listJiraProjects, createJiraIssue, attachImageToJiraIssue } from '../lib/jiraClient.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireProjectAccess)

const staffOnly = requireRole('qa_engineer', 'admin')

const SEVERITY_TO_PRIORITY = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }

function buildJiraDescription({ steps_to_reproduce, expected, actual, notes }) {
  const parts = []
  if (steps_to_reproduce) parts.push(`Steps to reproduce:\n${steps_to_reproduce}`)
  if (expected) parts.push(`Expected result:\n${expected}`)
  if (actual) parts.push(`Actual result:\n${actual}`)
  if (notes) parts.push(`Notes:\n${notes}`)
  return parts.join('\n\n') || '(No additional details provided.)'
}

// GET /projects/:id/bugs/jira/projects — staff only, populates the JIRA
// project picker on the bug-creation form. A clean error here (not
// configured, unreachable) is what lets the client disable the toggle
// instead of showing a broken picker.
router.get('/jira/projects', staffOnly, async (req, res) => {
  try {
    res.json(await listJiraProjects())
  } catch (e) {
    res.status(e instanceof JiraError ? e.status : 500).json({ error: e.message })
  }
})

// GET /projects/:id/bugs — staff + read-only clients who are project members
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.*, er.name AS execution_run_name
       FROM bugs b
       LEFT JOIN execution_runs er ON er.id = b.execution_run_id
       WHERE b.project_id=$1 ORDER BY
        CASE b.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        b.created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/bugs — staff only. `post_to_jira`/`jira` are optional;
// a JIRA failure never blocks the local bug from being created (fail-open,
// see DECISIONS.md) — it's surfaced back as `jira_error` on the response.
router.post('/', staffOnly, async (req, res) => {
  const { title, severity, steps_to_reproduce, expected, actual, notes, test_case_id, execution_run_id, post_to_jira, jira } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

  try {
    const { rows } = await query(
      `INSERT INTO bugs (project_id, test_case_id, execution_run_id, title, severity, steps_to_reproduce, expected, actual, notes, created_by, jira_organization)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, test_case_id || null, execution_run_id || null, title.trim(), severity || 'medium',
       steps_to_reproduce || null, expected || null, actual || null, notes || null, req.userId,
       post_to_jira ? (jira?.organization?.trim() || null) : null]
    )
    await query(`UPDATE projects SET updated_at=NOW() WHERE id=$1`, [req.params.id])
    let bug = rows[0]

    if (post_to_jira) {
      try {
        const issue = await createJiraIssue({
          projectKey: jira?.projectKey,
          summary: bug.title,
          description: buildJiraDescription(bug),
          priorityName: SEVERITY_TO_PRIORITY[bug.severity],
        })
        const { rows: updated } = await query(
          `UPDATE bugs SET jira_issue_key=$1, jira_issue_url=$2 WHERE id=$3 RETURNING *`,
          [issue.key, issue.url, bug.id]
        )
        bug = updated[0]

        if (jira?.image) {
          try {
            await attachImageToJiraIssue(issue.key, jira.image)
          } catch (attachErr) {
            bug = { ...bug, jira_error: `Posted to JIRA (${issue.key}), but the image failed to attach: ${attachErr.message}` }
          }
        }
      } catch (e) {
        bug = { ...bug, jira_error: e.message }
      }
    }

    res.status(201).json(bug)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// PATCH /bugs/:id — mounted at root in index.js
export async function patchBug(req, res) {
  const { status, title, severity, steps_to_reproduce, expected, actual, notes } = req.body

  const fields = []
  const values = []
  let i = 1

  if (status !== undefined) {
    if (!['open', 'in_progress', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    fields.push(`status=$${i++}`); values.push(status)
  }
  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: 'Title cannot be empty' })
    fields.push(`title=$${i++}`); values.push(title.trim())
  }
  if (severity !== undefined) {
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) return res.status(400).json({ error: 'Invalid severity' })
    fields.push(`severity=$${i++}`); values.push(severity)
  }
  if (steps_to_reproduce !== undefined) {
    fields.push(`steps_to_reproduce=$${i++}`); values.push(steps_to_reproduce)
  }
  if (expected !== undefined) {
    fields.push(`expected=$${i++}`); values.push(expected)
  }
  if (actual !== undefined) {
    fields.push(`actual=$${i++}`); values.push(actual)
  }
  if (notes !== undefined) {
    fields.push(`notes=$${i++}`); values.push(notes)
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' })

  fields.push(`updated_at=NOW()`)
  values.push(req.params.id)

  try {
    const { rows } = await query(
      `UPDATE bugs SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`,
      values
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,/

// GET /projects/:id/bugs/:bugId/comments — any project member (staff + client)
router.get('/:bugId/comments', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.*, u.name AS user_name, u.role AS user_role
       FROM bug_comments c
       JOIN bugs b ON b.id = c.bug_id
       JOIN users u ON u.id = c.user_id
       WHERE c.bug_id=$1 AND b.project_id=$2
       ORDER BY c.created_at ASC`,
      [req.params.bugId, req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /projects/:id/bugs/:bugId/comments — any project member (staff + client)
router.post('/:bugId/comments', async (req, res) => {
  const { body, image } = req.body
  if (!body?.trim() && !image) return res.status(400).json({ error: 'Comment needs text or an image' })
  if (image && !IMAGE_DATA_URL.test(image)) return res.status(400).json({ error: 'Invalid image format' })

  try {
    const { rows: bugRows } = await query(`SELECT id FROM bugs WHERE id=$1 AND project_id=$2`, [req.params.bugId, req.params.id])
    if (!bugRows[0]) return res.status(404).json({ error: 'Not found' })

    const { rows } = await query(
      `INSERT INTO bug_comments (bug_id, user_id, body, image_data) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.bugId, req.userId, body?.trim() || null, image || null]
    )
    const { rows: userRows } = await query(`SELECT name, role FROM users WHERE id=$1`, [req.userId])
    res.status(201).json({ ...rows[0], user_name: userRows[0]?.name, user_role: userRows[0]?.role })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
