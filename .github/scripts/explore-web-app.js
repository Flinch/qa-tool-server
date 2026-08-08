import { spawn } from 'child_process'
import readline from 'readline'
import https from 'https'
import http from 'http'

// Reads TARGET_URL straight from process.env — fetch-run-config.js already
// wrote it to $GITHUB_ENV in the previous step, same as generate-auth-
// setup.js's identical setup. No .generation-payload.json here either: this
// pipeline has no test plans, just one exploration prompt.
const {
  CORRELATION_ID,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  TARGET_URL,
  GITHUB_RUN_URL,
  GENERATION_COST_CAP_USD = '5',
  AGENT_TIMEOUT_MS = String(15 * 60 * 1000),
} = process.env

const COST_CAP = Number(GENERATION_COST_CAP_USD)
const AGENT_TIMEOUT = Number(AGENT_TIMEOUT_MS)

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
  process.exit(1)
}
if (!TARGET_URL) {
  console.error('TARGET_URL is required — did the "Fetch test environment" step run first?')
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
  return postJson(`${WEBHOOK_BASE_URL}/generation-events`, { correlation_id: CORRELATION_ID, status, github_run_url: GITHUB_RUN_URL || null, ...extra })
}

// Same buffer-then-flush shape as every other generation script — see
// generate-tests.js for why this is duplicated per-script rather than a
// shared lib.
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

  const cost = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0
  console.log(`  cost this call: $${result.total_cost_usd ?? '?'}`)
  if (cost > COST_CAP) {
    throw new CostCapExceededError(`Exploration cost cap ($${COST_CAP}) exceeded — spent $${cost.toFixed(2)}`)
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
  await reportEvent('exploring')

  const result = await runAgent(
    `Use the web-app-explorer agent to explore the real, live web app at ${TARGET_URL} and produce a plain-English summary of its screens, flows, and real UI element names.`
  )

  const summary = (result.result || '').trim()
  if (!summary) {
    throw new Error('Agent produced no summary text')
  }

  console.log(`Done. Summary is ${summary.length} characters.`)
  await reportEvent('completed', { summary })
}

main().then(async () => {
  clearInterval(logFlushInterval)
  await flushLogs()
  process.exit(0)
}).catch(async err => {
  console.error('Explore run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  clearInterval(logFlushInterval)
  await flushLogs().catch(() => {})
  process.exit(1)
})
