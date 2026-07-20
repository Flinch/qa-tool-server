import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import https from 'https'
import http from 'http'

const {
  CORRELATION_ID,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  GENERATION_COST_CAP_USD = '5',
  AGENT_TIMEOUT_MS = String(15 * 60 * 1000), // 15 min default per call
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

// Same reasoning as generate-tests.js: only report each phase transition once.
const reportedPhases = new Set()
async function reportPhaseOnce(status) {
  if (reportedPhases.has(status)) return
  reportedPhases.add(status)
  await reportEvent(status)
}

let totalCostUsd = 0
class CostCapExceededError extends Error {}
class AgentTimeoutError extends Error {}

// Identical process-tree-kill reasoning as generate-tests.js's runClaudeProcess
// — a killed `claude` process can otherwise leave orphaned children alive.
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

// Mobile equivalent of generate-tests.js's runPlaywrightTest — runs the whole
// suite dir for real against the connected device and reports pass/fail.
function runMaestroTest(targetDir) {
  return new Promise(resolve => {
    execFile('maestro', ['test', targetDir], (error) => {
      resolve(!error) // true = all passed, false = at least one failure
    })
  })
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

  try {
    const plannerList = entries.map(e => `- specs/${e.filename}`).join('\n')
    await runAgent(
      `Use the maestro-test-planner agent to verify and refine EACH of the following plans against app id "${appId}" on the connected device, following AGENTS.md's "Mobile tests (Maestro)" conventions. Update each file in place only if changes are needed. Process every plan in this list before finishing:\n${plannerList}\n\nIf a plan's stated Expect: outcome turns out to be genuinely contradicted by the app's real behavior (not a wording issue — the app actually does something different from what's described), do NOT keep retrying or waiting for the expected state to appear. Note it directly in the plan file with a BEHAVIOR MISMATCH comment describing expected vs actual, and move on to the next plan.`
    )
  } catch (err) {
    if (err instanceof CostCapExceededError) throw err
    const msg = `Planner batch failed, no TCs could be verified: ${err.message}`
    await reportEvent('failed', { error_message: msg.slice(0, 2000) })
    console.error(msg)
    process.exit(1)
  }

  await reportPhaseOnce('generating')

  let skipHealing = false
  try {
    const generatorList = entries.map(e => `- specs/${e.filename} -> ${e.specPath}`).join('\n')
    await runAgent(
      `Use the maestro-test-generator agent to implement EACH of the following plans as its corresponding Maestro flow YAML file, following AGENTS.md's "Mobile tests (Maestro)" conventions. Process every entry in this list:\n${generatorList}`
    )
  } catch (err) {
    if (err instanceof CostCapExceededError || err instanceof AgentTimeoutError) skipHealing = true
    console.error('Generator batch reported an error, checking what actually got written:', err.message)
  }

  const results = entries.map(e => fs.existsSync(e.specPath)
    ? { tc_id: e.tc_id, specPath: e.specPath, success: true }
    : { tc_id: e.tc_id, specPath: e.specPath, success: false, error: 'generator did not produce this file' })

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
    let clean = await runMaestroTest(suiteDir)
    for (let attempt = 1; attempt <= 3 && !clean; attempt++) {
      console.log(`Heal attempt ${attempt}/3`)
      await runAgent(
        `Use the maestro-test-healer agent to fix any failing flows in ${suiteDir}, following AGENTS.md's "Mobile tests (Maestro)" conventions. Do not weaken assertions — if a failure means app behavior changed rather than the flow being wrong, add a "# POSSIBLE REGRESSION" comment and a flagged-regression tag instead of forcing it to pass.`
      )
      clean = await runMaestroTest(suiteDir)
    }
    if (!clean) {
      console.warn('Heal loop exhausted (3 attempts) with flows still failing — proceeding to PR anyway (a flagged failure is still reviewable).')
    }
  }

  await reportPhaseOnce('opening_pr')
  console.log(`Done. ${succeeded.length}/${plans.length} test case(s) generated. Handing off to the PR step.`)
}

main().then(() => {
  process.exit(0)
}).catch(async err => {
  console.error('Generation run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  process.exit(1)
})
