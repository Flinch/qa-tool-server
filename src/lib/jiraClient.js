// Talks to JIRA Cloud's REST API v2 (plain-text description, no ADF) so bugs
// logged in this app can optionally also be filed as a real JIRA issue. Mirrors
// automationTrigger.js's shape on purpose: env vars read as plain consts with
// zero derived work at module scope, so importing this file can never throw at
// server startup (see the pdf-parse import-time incident in DECISIONS.md for
// why that matters here) — config presence is only checked inside functions,
// and every failure throws JiraError rather than being swallowed here; the
// route handler owns the fail-open decision.

const JIRA_BASE_URL = process.env.JIRA_BASE_URL
const JIRA_EMAIL = process.env.JIRA_EMAIL
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN

export class JiraError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function assertJiraConfigured() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new JiraError(500, 'JIRA is not configured on the server')
  }
}

function authHeader() {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`
}

// Projects the configured account can see — JIRA filters this server-side,
// so no extra permission filtering is needed on our end.
export async function listJiraProjects() {
  assertJiraConfigured()

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/2/project/search?maxResults=100`, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
  })
  if (!res.ok) {
    const errText = (await res.text()).slice(0, 500)
    throw new JiraError(502, `Couldn't list JIRA projects: ${errText}`)
  }
  const data = await res.json()
  return (data.values || []).map(p => ({ key: p.key, name: p.name, id: p.id }))
}

async function postIssue(fields) {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/2/issue`, {
    method: 'POST',
    headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  return res
}

// Team-managed Cloud projects frequently don't expose `priority` on the
// create screen at all, and JIRA rejects the whole request (not just that
// field) if you send one that isn't on-screen. Retry once without it rather
// than failing a create over a field the target project doesn't even use.
export async function createJiraIssue({ projectKey, summary, description, priorityName }) {
  assertJiraConfigured()
  if (!projectKey) throw new JiraError(400, 'No JIRA project selected')

  const baseFields = {
    project: { key: projectKey },
    summary,
    description,
    issuetype: { name: 'Bug' },
  }

  let res = await postIssue(priorityName ? { ...baseFields, priority: { name: priorityName } } : baseFields)

  if (!res.ok && priorityName) {
    const errText = await res.text()
    if (/priority/i.test(errText)) {
      res = await postIssue(baseFields)
    } else {
      throw new JiraError(res.status === 400 ? 400 : 502, `JIRA rejected the issue: ${errText.slice(0, 500)}`)
    }
  }

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 500)
    throw new JiraError(res.status === 400 ? 400 : 502, `JIRA rejected the issue: ${errText}`)
  }

  const { key } = await res.json()
  return { key, url: `${JIRA_BASE_URL}/browse/${key}` }
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/s

// Best-effort second call — issue creation already succeeded by the time this
// runs. Throws JiraError on failure like everything else here; the caller
// decides whether that should still block anything (it doesn't, per the
// fail-open decision in DECISIONS.md).
export async function attachImageToJiraIssue(issueKey, base64DataUrl) {
  assertJiraConfigured()

  const match = IMAGE_DATA_URL.exec(base64DataUrl || '')
  if (!match) throw new JiraError(400, 'Invalid image format')
  const buffer = Buffer.from(match[1], 'base64')
  const blob = new Blob([buffer])

  const form = new FormData()
  form.append('file', blob, 'attachment.jpg')

  // Do NOT set Content-Type manually here — fetch needs to generate its own
  // multipart boundary. Only the auth + JIRA's required no-check header go on.
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/2/issue/${issueKey}/attachments`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'X-Atlassian-Token': 'no-check' },
    body: form,
  })

  if (!res.ok) {
    const errText = (await res.text()).slice(0, 500)
    throw new JiraError(502, `Image attach to JIRA failed: ${errText}`)
  }
}
