import fs from 'fs'
import { execFile } from 'child_process'
import https from 'https'
import http from 'http'

// Reads TARGET_URL/AUTH_SETUP_FILE straight from process.env — unlike
// generate-tests.js, there's no .generation-payload.json here: this pipeline
// has no test plans, just the target env fetch-run-config.js already wrote
// to $GITHUB_ENV in the previous step.
const {
  CORRELATION_ID,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  TARGET_URL,
  AUTH_SETUP_FILE,
  GENERATION_COST_CAP_USD = '5',
  AGENT_TIMEOUT_MS = String(15 * 60 * 1000),
} = process.env

const COST_CAP = Number(GENERATION_COST_CAP_USD)
const AGENT_TIMEOUT = Number(AGENT_TIMEOUT_MS)

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
  process.exit(1)
}
if (!TARGET_URL || !AUTH_SETUP_FILE) {
  console.error('TARGET_URL and AUTH_SETUP_FILE are required — did the "Fetch test environment" step run first, and does this project have a custom target_url configured?')
  process.exit(1)
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const payload = JSON.stringify(body)
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        console.log(`generation-events -> ${res.statusCode}: ${data}`)
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function reportEvent(status, extra = {}) {
  return postJson(`${WEBHOOK_BASE_URL}/generation-events`, { correlation_id: CORRELATION_ID, status, ...extra })
}

const reportedPhases = new Set()
async function reportPhaseOnce(status) {
  if (reportedPhases.has(status)) return
  reportedPhases.add(status)
  await reportEvent(status)
}

let totalCostUsd = 0
class CostCapExceededError extends Error {}
class AgentTimeoutError extends Error {}

// Same process-tree-kill reasoning as generate-tests.js's identical helper.
function runClaudeProcess(args, { timeout, maxBuffer }) {
  return new Promise((resolve, reject) => {
    const child = execFile('npx', args, { maxBuffer, detached: true }, (error, stdout, stderr) => {
      clearTimeout(timer)
      if (error) return reject(Object.assign(error, { stdout, stderr }))
      resolve({ stdout, stderr })
    })

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      reject(new AgentTimeoutError(`Agent invocation timed out after ${timeout}ms and was killed.`))
    }, timeout)
  })
}

async function runAgent(prompt) {
  const { stdout } = await runClaudeProcess([
    'claude', '-p', prompt,
    '--permission-mode', 'dontAsk',
    '--output-format', 'json',
  ], { maxBuffer: 1024 * 1024 * 50, timeout: AGENT_TIMEOUT })

  const result = JSON.parse(stdout)
  if (typeof result.total_cost_usd === 'number') totalCostUsd += result.total_cost_usd
  console.log(`  cost this call: $${result.total_cost_usd ?? '?'}, running total: $${totalCostUsd.toFixed(4)}`)

  if (totalCostUsd > COST_CAP) {
    throw new CostCapExceededError(`Generation cost cap ($${COST_CAP}) exceeded — spent $${totalCostUsd.toFixed(2)} so far`)
  }
  if (result.permission_denials?.length) {
    throw new Error(`Agent hit ${result.permission_denials.length} permission denial(s): ${JSON.stringify(result.permission_denials).slice(0, 500)}`)
  }
  if (result.is_error) {
    throw new Error(`Agent invocation reported an error: ${result.result || '(no message)'}`)
  }
  return result
}

// Objective pass/fail — same shape as generate-tests.js's runPlaywrightTest,
// scoped to just the one file via the 'setup' project (playwright.config.js
// resolves AUTH_SETUP_FILE to this project's testMatch automatically).
function runAuthSetup() {
  return new Promise(resolve => {
    execFile('npx', ['playwright', 'test', AUTH_SETUP_FILE, '--project=setup'], (error) => {
      resolve(!error)
    })
  })
}

async function main() {
  await reportPhaseOnce('exploring')

  fs.mkdirSync('tests/auth-setups', { recursive: true })
  const isRetry = fs.existsSync(AUTH_SETUP_FILE)
  await runAgent(
    isRetry
      ? `Use the auth-setup-generator agent to fix ${AUTH_SETUP_FILE} — it already exists but failed when actually run. Investigate why (via test_debug) and fix it. The real target is ${TARGET_URL}, following AGENTS.md's "Auth setup generation" conventions.`
      : `Use the auth-setup-generator agent to generate ${AUTH_SETUP_FILE} from scratch by exploring the real, live login flow at ${TARGET_URL}, following AGENTS.md's "Auth setup generation" conventions.`
  )

  if (!fs.existsSync(AUTH_SETUP_FILE)) {
    const msg = `Agent did not produce ${AUTH_SETUP_FILE}`
    await reportEvent('failed', { error_message: msg })
    console.error(msg)
    process.exit(1)
  }

  await reportPhaseOnce('healing')
  let clean = await runAuthSetup()
  for (let attempt = 1; attempt <= 3 && !clean; attempt++) {
    console.log(`Auth-setup fix attempt ${attempt}/3`)
    try {
      await runAgent(
        `Use the auth-setup-generator agent to fix ${AUTH_SETUP_FILE} — it just failed a real run against ${TARGET_URL}. Investigate why (via test_debug) and fix it, following AGENTS.md's "Auth setup generation" conventions.`
      )
    } catch (err) {
      if (err instanceof CostCapExceededError) throw err
      console.error('Fix attempt errored, will still re-check the file as written:', err.message)
    }
    clean = await runAuthSetup()
  }

  // Proceeds to PR either way — the workflow's own independent verify step
  // (run fresh, not trusted from this script) decides what the PR title
  // says, and a human reviewing an "UNVERIFIED" PR is the real gate, not
  // this script. See lib/authSetupStatus.js: the actual block/unblock
  // signal is PR-merged, not this outcome.
  if (!clean) {
    console.warn('Could not get the login flow to pass after 3 fix attempts — proceeding to PR anyway, flagged for review.')
  } else {
    console.log('Login flow verified working.')
  }

  await reportPhaseOnce('opening_pr')
  console.log(`Done. ${AUTH_SETUP_FILE} written${clean ? ' and verified' : ' (unverified)'}. Handing off to the PR step.`)
}

main().then(() => {
  process.exit(0)
}).catch(async err => {
  console.error('Auth-setup generation run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  process.exit(1)
})
