import fs from 'fs'
import path from 'path'
import { execFile, spawn } from 'child_process'
import readline from 'readline'
import https from 'https'
import http from 'http'

const {
  CORRELATION_ID,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  GITHUB_RUN_URL,
  GENERATION_COST_CAP_USD = '5',
  AGENT_TIMEOUT_MS = String(25 * 60 * 1000), // 25 min default per call — bumped from 15 after a real iOS checkout verification (shipping+payment+review, 4 screens) ran out of clock time on legitimate work, not a stall
} = process.env

const COST_CAP = Number(GENERATION_COST_CAP_USD)
const AGENT_TIMEOUT = Number(AGENT_TIMEOUT_MS)

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
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

// Same reasoning as generate-tests.js: only report each phase transition once.
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

// One line per stream-json event so the live GitHub Actions log actually
// shows the agent's tool calls and reasoning as they happen, instead of
// nothing until the whole multi-minute turn completes (the old buffered
// --output-format json gave no visibility into what the agent was doing —
// only a single result blob at the very end). Deliberately terse (one line
// per block, hard-truncated) since this streams into a CI log meant for a
// human watching live, not a full transcript archive. Also pushed into
// logBuffer so the app's own log viewer gets the same feed, not just the
// GH Actions log.
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

// Identical process-tree-kill reasoning as generate-tests.js's runClaudeProcess
// — a killed `claude` process can otherwise leave orphaned children alive.
// Streams stdout line-by-line (stream-json is one JSON object per line)
// instead of buffering the whole call like execFile did, printing each
// event live as it arrives. The final `result` event carries the exact same
// fields (total_cost_usd/is_error/permission_denials/result) the old
// buffered `--output-format json` mode returned, so runAgent below barely
// changes.
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
        return // a stray non-JSON line shouldn't kill the whole run
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

// Mobile equivalent of generate-tests.js's runPlaywrightTest — runs each flow
// file as its OWN `maestro test` invocation rather than the whole dir in one
// batch call. Returns per-file pass/fail. One invocation per flow the same
// reasoning as main()'s per-TC agent loop below — see that comment.
//
// `fileNames` is required, not defaulted to a full directory scan: this
// generation pipeline heals only what it just wrote this run, never the rest
// of the suite. Running (and auto-healing) every pre-existing flow on every
// single new-TC generation meant one unrelated, already-merged flow going
// red could silently burn a whole run's time/cost investigating a regression
// nobody asked this run to look at. Suite-wide regression checking still
// happens — via the existing "Run suite" execution trigger — just as an
// explicit, deliberate action instead of a surprise side effect of
// generating one new test case.
async function runMaestroTest(targetDir, fileNames) {
  const files = fileNames
  const status = {}
  for (const file of files) {
    status[file] = await new Promise(resolve => {
      execFile('maestro', ['test', path.join(targetDir, file)], (error) => {
        resolve(!error) // true = passed, false = failed
      })
    })
  }
  return status
}

async function main() {
  const payload = JSON.parse(fs.readFileSync('.generation-payload.json', 'utf-8'))
  const { suite_slug: suiteSlug, platform, app_id: appId, plans } = payload
  const suiteDir = path.join('tests', 'generated-mobile', platform, suiteSlug)
  fs.mkdirSync(suiteDir, { recursive: true })

  const entries = plans.map(plan => ({
    ...plan,
    specPath: path.join(suiteDir, plan.filename.replace(/\.md$/, '.yaml')),
  }))

  // Planner: one `claude -p` process PER test case, not one process handling
  // the whole list via internal sub-agent dispatch (the old approach). Each
  // top-level `claude -p` call spawns its own `maestro mcp` server (per
  // .mcp.json) and therefore its own fresh XCUITest driver. This sidesteps a
  // confirmed upstream bug (maestro-org/maestro#3368, #3318, #3254): the iOS
  // driver process can die mid-session and is never restarted or reconnected
  // — list_devices keeps reporting connected:true the whole time (it only
  // checks simulator OS boot state), while every driver-mediated call
  // (inspect_screen/run/launchApp/take_screenshot) fails against the same
  // dead port for the rest of the session. One TC per process means a dead
  // driver can only ever take down that one TC, not the whole batch — and
  // Node's serial `for` loop already prevents the concurrent-dispatch issue
  // the old prompt text used to warn against, so that instruction is gone too.
  const plannerOk = new Set()
  for (const entry of entries) {
    try {
      await runAgent(
        `Use the maestro-test-planner agent to verify and refine the plan at specs/${entry.filename} against app id "${appId}" on the connected device, following AGENTS.md's "Mobile tests (Maestro)" conventions. Update the file in place only if changes are needed.\n\nThis plan already exists — your job is to confirm it against the real app, not to rediscover the app from scratch. Only navigate to and inspect the specific screens this plan's steps already reference; do not explore unrelated screens or flows (catalog browsing, checkout, settings, orientation changes, etc.) the plan doesn't call for.\n\nIf the plan's stated Expect: outcome turns out to be genuinely contradicted by the app's real behavior (not a wording issue — the app actually does something different from what's described), do NOT keep retrying or waiting for the expected state to appear. Note it directly in the plan file with a BEHAVIOR MISMATCH comment describing expected vs actual.`
      )
      plannerOk.add(entry.tc_id)
    } catch (err) {
      if (err instanceof CostCapExceededError) throw err
      console.error(`Planner failed for TC ${entry.tc_id}: ${err.message}`)
    }
  }
  if (plannerOk.size === 0) {
    const msg = `Planner failed for every TC: ${entries.map(e => e.tc_id).join(', ')}`
    await reportEvent('failed', { error_message: msg.slice(0, 2000) })
    console.error(msg)
    process.exit(1)
  }

  await reportPhaseOnce('generating')

  // Generator: same one-process-per-TC split as the planner above, and only
  // for TCs the planner actually verified — no point generating code from an
  // unverified plan.
  let skipHealing = false
  for (const entry of entries) {
    if (!plannerOk.has(entry.tc_id)) continue
    // specPath lives under tests/generated-mobile/, which is git-tracked —
    // a TC that's already been generated and merged (like TC-78) leaves that
    // file present in every future checkout, including on a REtry. Without
    // clearing it first, a generator that fails outright this run would
    // still find the old, merged file below and falsely report success —
    // same "trust a fixed path without confirming this run wrote it" mistake
    // as the fixed runMaestroTest/junitPath bug, just for generation instead
    // of execution.
    fs.rmSync(entry.specPath, { force: true })
    try {
      await runAgent(
        `Use the maestro-test-generator agent to implement the plan at specs/${entry.filename} as its corresponding Maestro flow YAML file at ${entry.specPath}, following AGENTS.md's "Mobile tests (Maestro)" conventions.`
      )
    } catch (err) {
      if (err instanceof CostCapExceededError || err instanceof AgentTimeoutError) { skipHealing = true; break }
      console.error(`Generator failed for TC ${entry.tc_id}: ${err.message}`)
    }
  }

  const results = entries.map(e => fs.existsSync(e.specPath)
    ? { tc_id: e.tc_id, specPath: e.specPath, success: true }
    : { tc_id: e.tc_id, specPath: e.specPath, success: false, error: plannerOk.has(e.tc_id) ? 'generator did not produce this file' : 'skipped: planner did not verify this TC' })

  for (const r of results) {
    if (!r.success) console.error(`TC ${r.tc_id} failed to generate: ${r.error}`)
  }

  const succeeded = results.filter(r => r.success)
  if (succeeded.length === 0) {
    const combined = results.map(r => `TC ${r.tc_id}: ${r.error}`).join('; ')
    const prefix = skipHealing ? 'Generation was cut short (cost cap or timeout) and nothing was generated successfully. ' : 'No test cases generated successfully. '
    await reportEvent('failed', { error_message: `${prefix}${combined}`.slice(0, 2000) })
    console.error('Nothing generated — failing the run.')
    process.exit(1)
  }

  if (skipHealing) {
    console.warn(`Generation was cut short (cost cap or timeout) — skipping the heal loop. Proceeding to PR with ${succeeded.length}/${entries.length} test case(s) as generated (unhealed).`)
  } else {
    await reportPhaseOnce('healing')
    // Only the flow(s) generated THIS run — not a sweep of the whole suite
    // directory. See runMaestroTest's comment for why.
    const generatedFileNames = succeeded.map(r => path.basename(r.specPath))
    let statusByFile = await runMaestroTest(suiteDir, generatedFileNames)
    let failingFiles = Object.entries(statusByFile).filter(([, ok]) => !ok).map(([f]) => f)
    for (let attempt = 1; attempt <= 3 && failingFiles.length > 0; attempt++) {
      console.log(`Heal attempt ${attempt}/3: ${failingFiles.join(', ')}`)
      // One healer process per failing flow — same fresh-driver reasoning as
      // the planner/generator loops above.
      for (const file of failingFiles) {
        try {
          await runAgent(
            `Use the maestro-test-healer agent to fix the failing flow at ${path.join(suiteDir, file)}, following AGENTS.md's "Mobile tests (Maestro)" conventions. Do not weaken assertions — if the failure means app behavior changed rather than the flow being wrong, add a "# POSSIBLE REGRESSION" comment and a flagged-regression tag instead of forcing it to pass.`
          )
        } catch (err) {
          if (err instanceof CostCapExceededError) throw err
          console.error(`Healer failed for ${file}: ${err.message}`)
        }
      }
      statusByFile = await runMaestroTest(suiteDir, generatedFileNames)
      failingFiles = Object.entries(statusByFile).filter(([, ok]) => !ok).map(([f]) => f)
    }
    if (failingFiles.length > 0) {
      console.warn(`Heal loop exhausted (3 attempts) with ${failingFiles.length} flow(s) still failing — proceeding to PR anyway (a flagged failure is still reviewable).`)
    }
  }

  await reportPhaseOnce('opening_pr')
  console.log(`Done. ${succeeded.length}/${plans.length} test case(s) generated. Handing off to the PR step.`)
}

main().then(async () => {
  clearInterval(logFlushInterval)
  await flushLogs()
  process.exit(0)
}).catch(async err => {
  console.error('Generation run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  clearInterval(logFlushInterval)
  await flushLogs().catch(() => {})
  process.exit(1)
})
