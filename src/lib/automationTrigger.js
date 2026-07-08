import crypto from 'crypto'
import { query } from '../db/pool.js'

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO = process.env.GITHUB_REPO
const GITHUB_WORKFLOW_ID = process.env.GITHUB_WORKFLOW_ID // e.g. "playwright.yml"

class TriggerError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// Dispatches a suite run via GitHub Actions workflow_dispatch and records the
// pending test_runs row. Shared by the Automation page's "Run suite" action
// and by Execution Runs triggering a suite from inside a session.
export async function triggerSuiteRun({ projectId, suiteId, userId }) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !GITHUB_WORKFLOW_ID) {
    throw new TriggerError(500, 'GitHub Actions is not configured on the server')
  }

  const { rows: suiteRows } = await query(
    `SELECT * FROM automation_suites WHERE id=$1 AND project_id=$2`,
    [suiteId, projectId]
  )
  if (!suiteRows[0]) throw new TriggerError(404, 'Suite not found')
  const suite = suiteRows[0]

  const correlationId = crypto.randomUUID()

  const { rows } = await query(
    `INSERT INTO test_runs (project_id, suite_id, correlation_id, trigger_type, status, created_by)
     VALUES ($1,$2,$3,'manual','pending',$4) RETURNING *`,
    [projectId, suiteId, correlationId, userId]
  )

  const ghRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_ID}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'master',
        inputs: {
          suite_slug: suite.slug,
          run_correlation_id: correlationId,
        },
      }),
    }
  )

  if (!ghRes.ok) {
    const errText = await ghRes.text()
    await query(`UPDATE test_runs SET status='failed' WHERE id=$1`, [rows[0].id])
    throw new TriggerError(502, `GitHub Actions dispatch failed: ${errText}`)
  }

  return rows[0]
}
