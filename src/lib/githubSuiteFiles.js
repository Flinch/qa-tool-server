// Lists a suite's real generated test files from GitHub and matches them back
// to automated_test_cases roster rows — no filename reconstruction (real
// generated filenames are slugified/truncated in ways that aren't reliably
// reproducible, e.g. "tc-54-submitting-the-new-ticket-form-with-all-required-
// fields-crea.spec.ts"), just a live directory listing plus the same tc-<id>
// prefix match already used elsewhere (webhooks.js, requirements.js) to tie a
// title back to a real test case. Same fail-open shape as githubPrStatus.js.
const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env

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

export function suiteDirectory(suite) {
  return suite.platform === 'web'
    ? `tests/generated/${suite.slug}`
    : `tests/generated-mobile/${suite.platform}/${suite.slug}`
}

// Real files with their real GitHub blob-view links — nothing constructed
// by hand, so there's no risk of a dead link from a wrong guess.
export async function listSuiteFiles(suite) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return []

  try {
    const dir = suiteDirectory(suite)
    const entries = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${dir}`)
    if (!Array.isArray(entries)) return []
    return entries
      .filter(e => e.type === 'file')
      .map(e => ({ name: e.name, path: e.path, url: e.html_url }))
  } catch {
    return []
  }
}

function extractTcId(text) {
  const match = /^tc-(\d+)/i.exec(text)
  return match ? match[1] : null
}

// Returns the matching file's url, or null — never a fuzzy/wrong guess. A
// title with no tc-<id> prefix (hand-added roster rows like "authenticate")
// simply gets no link, same as a suite with no matching file.
export function matchTestCaseToFile(title, files) {
  const tcId = extractTcId(title)
  if (!tcId) return null
  const match = files.find(f => extractTcId(f.name) === tcId)
  return match?.url || null
}
