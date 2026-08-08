import { spawn, execFile } from 'child_process'
import fs from 'fs'
import readline from 'readline'
import https from 'https'
import http from 'http'

// APP_ID comes from fetch-run-config.js's writeEnv() (now additive there —
// see that file's comment) resolving project_test_config.mobile_app_id_ios/
// android for whichever `platform` this run was dispatched with.
//
// TEST_USER_NAME/TEST_USER_PASSWORD are read directly here, by this real
// Node process, and used ONLY in the raw `maestro test -e ...` CLI call
// below — never passed into an agent's prompt or the maestro MCP server.
// Confirmed live (twice) that a Claude Code subagent has no way to get a
// real secret into a Maestro flow run through the `mcp__maestro__run` tool:
// Maestro's `${VAR}` substitution requires an explicit `-e KEY=VALUE` CLI
// flag, which that tool's schema doesn't expose (only device_id/yaml) — so
// any credential token in an agent-authored flow always resolved to the
// literal string "undefined". See mobile-login-flow-writer.md for the split
// this forces: one agent maps the login screen's real structure (never
// touching a real credential), this script executes it for real afterward.
const {
  CORRELATION_ID,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  APP_ID,
  TEST_USER_NAME,
  TEST_USER_PASSWORD,
  GITHUB_RUN_URL,
  INSTRUCTIONS,
  GENERATION_COST_CAP_USD = '5',
  AGENT_TIMEOUT_MS = String(15 * 60 * 1000),
} = process.env

const LOGIN_FLOW_PATH = 'mobile-explore-login-flow.yaml'

const COST_CAP = Number(GENERATION_COST_CAP_USD)
const AGENT_TIMEOUT = Number(AGENT_TIMEOUT_MS)

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
  process.exit(1)
}
if (!APP_ID) {
  console.error('APP_ID is required — did the "Fetch test environment" step run first?')
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

// The one place a real credential ever gets used — a direct CLI call, no
// agent or MCP tool involved. `-e` is Maestro's own documented mechanism
// for resolving ${VAR} tokens in a flow file; confirmed working via
// `maestro test --help` (unlike the mcp__maestro__run tool, which has no
// equivalent flag). TEST_USER_NAME/PASSWORD are already ::add-mask::ed by
// fetch-run-config.js, so they're redacted from this step's log too despite
// appearing in the argv here.
function runLoginFlow(flowPath) {
  return new Promise((resolve, reject) => {
    execFile('maestro', [
      'test', '--no-ansi',
      '-e', `TEST_USER_NAME=${TEST_USER_NAME || ''}`,
      '-e', `TEST_USER_PASSWORD=${TEST_USER_PASSWORD || ''}`,
      flowPath,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stdout) console.log(stdout)
      if (stderr) console.error(stderr)
      if (err) {
        reject(new Error(`Login flow run failed (exit code ${err.code}): ${(stderr || stdout || err.message).slice(0, 1000)}`))
        return
      }
      resolve()
    })
  })
}

async function main() {
  await reportEvent('exploring')

  if (!TEST_USER_NAME || !TEST_USER_PASSWORD) {
    console.log('No test credentials configured for this project — skipping the login-mapping phase entirely.')
  }

  // Phase 1: map the login screen's real structure (if any) without ever
  // touching a real credential — see mobile-login-flow-writer.md for why
  // this has to be a separate, narrower agent from the explorer below.
  let loggedIn = false
  if (TEST_USER_NAME && TEST_USER_PASSWORD) {
    try {
      fs.rmSync(LOGIN_FLOW_PATH, { force: true })
    } catch { /* ignore */ }

    await runAgent(
      `Use the mobile-login-flow-writer agent to find the login screen (if any) for the real, live mobile app with ` +
      `app id ${APP_ID}, and write a Maestro login flow to the exact path "${LOGIN_FLOW_PATH}" using ` +
      `\${TEST_USER_NAME}/\${TEST_USER_PASSWORD} tokens — never a real or probe credential in the written file.`
    )

    if (fs.existsSync(LOGIN_FLOW_PATH)) {
      console.log(`Login flow written to ${LOGIN_FLOW_PATH} — running it for real with the actual test account.`)
      try {
        await runLoginFlow(LOGIN_FLOW_PATH)
        loggedIn = true
        console.log('Login flow completed successfully.')
      } finally {
        fs.rmSync(LOGIN_FLOW_PATH, { force: true })
      }
    } else {
      console.log('No login flow was written (no login screen found, or it could not be mapped) — exploring fresh.')
    }
  }

  // Phase 2: the actual exploration, now either already logged in (device
  // state persists across separate `claude -p` invocations since it's a
  // real physical device, not per-session state) or starting fresh.
  const stateGuidance = loggedIn
    ? `\n\nThe app is already open and logged in — a login flow just ran successfully with the real test account. ` +
      `Do NOT call launchApp with clearState (that would log you back out) — call inspect_screen first to see ` +
      `where you actually are, then continue.`
    : ''
  const guidance = INSTRUCTIONS?.trim()
    ? `\n\nAdditional guidance from the user for this exploration — follow it: ${INSTRUCTIONS.trim()}`
    : ''
  const result = await runAgent(
    `Use the mobile-app-explorer agent to explore the real, live mobile app with app id ${APP_ID} and produce a plain-English summary of its screens, flows, and real UI element names.${stateGuidance}${guidance}`
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
