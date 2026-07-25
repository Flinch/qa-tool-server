// Checks a generation run's PR live against the GitHub API — no webhook
// receiver for pull_request events exists in this app, and standing one up
// requires GitHub-side configuration, not just code. A live check on read is
// simpler and sufficient: this is called for a handful of recent runs per
// page load, not a hot path. Fails open per-PR (returns { merged: false }
// on any error) so one bad lookup can't break the whole history panel —
// the raw pr_url still works as a fallback link either way.
const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env

function parsePrNumber(prUrl) {
  const match = /\/pull\/(\d+)/.exec(prUrl || '')
  return match ? match[1] : null
}

async function ghGet(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`)
  return res.json()
}

// Returns { merged: false } for an open/unmerged PR (caller just links
// pr_url directly), or { merged: true, files: [{path, url}] } — the actual
// ask: once a PR is closed out, link straight to where the test now lives
// instead of a dead-end merged-PR page.
export async function getPrStatus(prUrl) {
  const number = parsePrNumber(prUrl)
  if (!number || !GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return { merged: false }

  try {
    const pr = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${number}`)
    if (!pr.merged) return { merged: false }

    const files = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${number}/files`)
    const base = pr.base?.ref || 'master'
    return {
      merged: true,
      files: files
        .filter(f => f.status !== 'removed')
        .map(f => ({ path: f.filename, url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/blob/${base}/${f.filename}` })),
    }
  } catch {
    return { merged: false }
  }
}
