// One-off "diagnose and heal" for a SINGLE already-existing failing Maestro
// flow, triggered from a test execution run's failed result — not a batch
// generation run. Same generation_runs/generation-events webhook contract as
// generate-mobile-tests.js (this file's harness below is copied from there
// verbatim, same duplication-over-shared-lib precedent already established
// between the two existing generate scripts), just narrower: no planner, no
// per-TC loop, one healer call at one file. Re-verification of the fix
// happens inside the healer agent itself (AGENTS.md's healing rules already
// require "re-run after every fix, never mark something fixed without a real
// passing run") — this script doesn't re-check pass/fail after the fact.

import { spawn } from 'child_process'
import readline from 'readline'
import https from 'https'
import http from 'http'

const {
  CORRELATION_ID,
  FILE_PATH,
  CONTEXT,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  GENERATION_COST_CAP_USD = '5',
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

function reportEvent(status, extra = {}) {
  return postJson(`${WEBHOOK_BASE_URL}/generation-events`, { correlation_id: CORRELATION_ID, status, ...extra })
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

async function main() {
  await reportPhaseOnce('healing')
  const contextNote = CONTEXT?.trim()
    ? ` Additional context from the user, follow it as an instruction alongside the rules below: "${CONTEXT.trim()}"`
    : ''
  await runAgent(
    `Use the maestro-test-healer agent to fix the failing flow at ${FILE_PATH}, following AGENTS.md's "Mobile tests (Maestro)" conventions. Do not weaken assertions — if the failure means app behavior changed rather than the flow being wrong, add a "# POSSIBLE REGRESSION" comment and a flagged-regression tag instead of forcing it to pass.${contextNote}`
  )

  // Script's job ends here, same handoff as generate-mobile-tests.js — the
  // workflow's own next steps (peter-evans/create-pull-request, then a final
  // generation-events call with the real pr_url/branch_name) run outside
  // this script, and open the PR regardless of whether the healer got a full
  // pass or left a flagged regression — always reviewable, never silently
  // dropped.
  await reportPhaseOnce('opening_pr')
  console.log(`Done healing ${FILE_PATH}. Handing off to the PR step.`)
}

main().then(async () => {
  clearInterval(logFlushInterval)
  await flushLogs()
  process.exit(0)
}).catch(async err => {
  console.error('Heal run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  clearInterval(logFlushInterval)
  await flushLogs().catch(() => {})
  process.exit(1)
})
