// One-off "diagnose and heal" for a SINGLE already-existing failing
// Playwright spec, triggered from a test execution run's failed result —
// not a batch generation run. Same generation_runs/generation-events webhook
// contract as generate-tests.js. Uses the newer streaming agent harness from
// generate-mobile-tests.js (not generate-tests.js's older buffered one) for
// live visibility into a real CI run, same duplication-over-shared-lib
// precedent already established between the two existing generate scripts.
// Re-verification of the fix happens inside the healer agent itself
// (AGENTS.md requires "re-run after every fix, never mark something fixed
// without a real passing run") — this script doesn't re-check pass/fail.

import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import readline from 'readline'
import https from 'https'
import http from 'http'

const execFileAsync = promisify(execFile)

const {
  CORRELATION_ID,
  FILE_PATH,
  CONTEXT,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  GITHUB_RUN_URL,
  GENERATION_COST_CAP_USD = '5',
  // Bumped from 15 after two real heal attempts (TC-63, TC-65 — 2026-08-03)
  // were killed mid-edit with real progress made (files already changed,
  // re-verification just not reached yet), not stuck/looping. Both needed
  // multiple diagnose-edit-verify cycles against a slow/occasionally-flaky
  // shared demo (even login itself intermittently failed on one run) —
  // same "ran out of clock time on legitimate work" situation that already
  // justified generate-mobile-tests.js's identical 15->25 bump.
  AGENT_TIMEOUT_MS = String(25 * 60 * 1000),
} = process.env

const COST_CAP = Number(GENERATION_COST_CAP_USD)
const AGENT_TIMEOUT = Number(AGENT_TIMEOUT_MS)

if (!CORRELATION_ID || !FILE_PATH || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, FILE_PATH, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
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
        console.log(`${u.pathname} -> ${res.statusCode}: ${data}`)
        resolve({ status: res.statusCode, data })
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(u, {
      method: 'GET',
      headers: { 'x-webhook-secret': WEBHOOK_SECRET },
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        console.log(`${u.pathname} -> ${res.statusCode}`)
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function reportEvent(status, extra = {}) {
  return postJson(`${WEBHOOK_BASE_URL}/generation-events`, { correlation_id: CORRELATION_ID, status, github_run_url: GITHUB_RUN_URL || null, ...extra })
}

const reportedPhases = new Set()
async function reportPhaseOnce(status) {
  if (reportedPhases.has(status)) return
  reportedPhases.add(status)
  await reportEvent(status)
}

// Same buffer-then-flush shape as generate-tests.js's identical addition —
// see that file's comment for why this is duplicated per-script rather
// than a shared lib.
const logBuffer = []
let flushingLogs = false
async function flushLogs() {
  if (flushingLogs || logBuffer.length === 0) return
  flushingLogs = true
  const lines = logBuffer.splice(0, logBuffer.length)
  try {
    await postJson(`${WEBHOOK_BASE_URL}/generation-logs`, { correlation_id: CORRELATION_ID, lines })
  } catch (e) {
    console.error('Failed to flush agent log lines:', e.message)
  } finally {
    flushingLogs = false
  }
}
const logFlushInterval = setInterval(flushLogs, 2000)

let totalCostUsd = 0
class CostCapExceededError extends Error {}
class AgentTimeoutError extends Error {}

function truncateForLog(value, max) {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function printStreamEvent(event) {
  if (event.type !== 'assistant' && event.type !== 'user') return
  for (const block of event.message?.content || []) {
    let line = null
    if (block.type === 'thinking' && block.thinking) {
      line = `🤔 ${truncateForLog(block.thinking, 200)}`
    } else if (block.type === 'tool_use') {
      line = `🔧 ${block.name}(${truncateForLog(block.input, 150)})`
    } else if (block.type === 'text' && block.text) {
      line = `💬 ${truncateForLog(block.text, 300)}`
    } else if (block.type === 'tool_result') {
      const prefix = block.is_error ? 'ERROR: ' : ''
      line = `↳ ${prefix}${truncateForLog(block.content, 200)}`
    }
    if (line) {
      console.log(`  ${line}`)
      logBuffer.push(line)
    }
  }
}

function runClaudeProcess(args, { timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', args, { detached: true })

    let resultEvent = null
    let stderr = ''
    child.stderr.on('data', d => { stderr += d })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      printStreamEvent(event)
      if (event.type === 'result') resultEvent = event
    })

    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      reject(new AgentTimeoutError(`Agent invocation timed out after ${timeout}ms and was killed.`))
    }, timeout)

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (!resultEvent) {
        reject(Object.assign(new Error(`Agent process exited (code ${code}) without a result event`), { stderr }))
        return
      }
      resolve(resultEvent)
    })
  })
}

async function runAgent(prompt) {
  const result = await runClaudeProcess([
    'claude', '-p', prompt,
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json',
    '--verbose',
  ], { timeout: AGENT_TIMEOUT })

  if (typeof result.total_cost_usd === 'number') totalCostUsd += result.total_cost_usd
  console.log(`  cost this call: $${result.total_cost_usd ?? '?'}, running total: $${totalCostUsd.toFixed(4)}`)

  if (totalCostUsd > COST_CAP) {
    throw new CostCapExceededError(`Heal cost cap ($${COST_CAP}) exceeded — spent $${totalCostUsd.toFixed(2)} so far`)
  }
  if (result.permission_denials?.length) {
    throw new Error(`Agent hit ${result.permission_denials.length} permission denial(s): ${JSON.stringify(result.permission_denials).slice(0, 500)}`)
  }
  if (result.is_error) {
    throw new Error(`Agent invocation reported an error: ${result.result || '(no message)'}`)
  }
  return result
}

// A stateless CI job otherwise has no memory that a previous attempt at
// this exact test ever happened, and repeats the same diagnosis work from
// scratch every time (confirmed live, 2026-08-03: two independent TC-65
// heal attempts, hours apart, independently rediscovered the same root
// cause). Only the agent's own narration lines are included, not raw tool
// traffic — that's normally where the actual diagnosis lives.
function formatPriorAttempts(attempts) {
  if (!attempts || attempts.length === 0) return ''
  const blocks = attempts.map((a, i) => {
    const outcome = a.status === 'completed' && a.pr_url
      ? `completed, opened ${a.pr_url}`
      : a.status === 'failed'
        ? `failed — ${a.error_message || '(no error message recorded)'}`
        : a.status
    const narrationText = a.narration?.length > 0 ? a.narration.join('\n') : '(no narration recorded)'
    return `Attempt ${i + 1} (${a.started_at}, ${outcome}):\n${narrationText}`
  })
  return `\n\nPRIOR ATTEMPTS AT THIS EXACT TEST (most recent first) — do not waste time re-deriving a diagnosis these already reached; verify it's still accurate and build on it, or explain why it's now wrong before trying something else:\n\n${blocks.join('\n\n')}`
}

// Every prior failed heal (TC-63, TC-65 — 2026-08-03) discarded 100% of its
// progress on timeout: nothing gets committed until the very end, so a
// killed agent's correct diagnosis and real file edits just vanish, and the
// next attempt starts from zero. This is the other half of that fix — on
// any failure, whatever the agent already changed on disk (still there;
// SIGKILL only kills the agent subprocess, not the filesystem writes it
// already made) gets committed and pushed to its own checkpoint branch
// instead of being silently lost. Deliberately a distinct branch name from
// the success path's healed-tests/<correlation_id> (created by
// create-pull-request in the workflow) so this never collides with it.
const CHECKPOINT_BRANCH = `healed-tests/${CORRELATION_ID}-checkpoint`

async function checkpointProgress(reasonForFailure) {
  try {
    const { stdout: statusOutput } = await execFileAsync('git', ['status', '--porcelain'])
    if (!statusOutput.trim()) {
      console.log('No uncommitted changes to checkpoint.')
      return null
    }

    await execFileAsync('git', ['config', 'user.email', 'healer-bot@qa-tool.local'])
    await execFileAsync('git', ['config', 'user.name', 'QA Tool Healer'])
    await execFileAsync('git', ['checkout', '-b', CHECKPOINT_BRANCH])
    await execFileAsync('git', ['add', '-A'])
    await execFileAsync('git', [
      'commit', '-m',
      `Checkpoint: partial heal progress at ${FILE_PATH}\n\nAgent was interrupted before finishing: ${reasonForFailure}\n\nNot verified passing — review before using.`,
    ])
    await execFileAsync('git', ['push', 'origin', `HEAD:refs/heads/${CHECKPOINT_BRANCH}`])
    console.log(`Checkpointed partial progress to branch ${CHECKPOINT_BRANCH}`)
    return CHECKPOINT_BRANCH
  } catch (e) {
    console.error('Failed to checkpoint partial progress (continuing to report failure anyway):', e.message)
    return null
  }
}

async function main() {
  await reportPhaseOnce('healing')

  const history = await getJson(`${WEBHOOK_BASE_URL}/heal-history/${CORRELATION_ID}`).catch(e => {
    console.error('Failed to fetch prior heal attempts (continuing without them):', e.message)
    return { attempts: [] }
  })
  const priorAttemptsNote = formatPriorAttempts(history.attempts)

  const contextNote = CONTEXT?.trim()
    ? ` Additional context from the user, follow it as an instruction alongside the rules below: "${CONTEXT.trim()}"`
    : ''
  await runAgent(
    `Use the playwright-test-healer agent to fix any failing tests in ${FILE_PATH}, following AGENTS.md conventions. Do not weaken assertions — if a failure means app behavior changed rather than the test being wrong, mark it with test.fixme() and a POSSIBLE REGRESSION comment instead of forcing it to pass.${contextNote}${priorAttemptsNote}`
  )

  await reportPhaseOnce('opening_pr')
  console.log(`Done healing ${FILE_PATH}. Handing off to the PR step.`)
}

main().then(async () => {
  clearInterval(logFlushInterval)
  await flushLogs()
  process.exit(0)
}).catch(async err => {
  console.error('Heal run failed:', err.message)
  const checkpointBranch = await checkpointProgress(err.message)
  await reportEvent('failed', {
    error_message: err.message.slice(0, 2000),
    branch_name: checkpointBranch || undefined,
  }).catch(() => {})
  clearInterval(logFlushInterval)
  await flushLogs().catch(() => {})
  process.exit(1)
})
