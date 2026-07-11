import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import https from 'https'
import http from 'http'

const execFileAsync = promisify(execFile)

const {
  CORRELATION_ID,
  WEBHOOK_BASE_URL,
  WEBHOOK_SECRET,
  GENERATION_COST_CAP_USD = '5',
} = process.env

const COST_CAP = Number(GENERATION_COST_CAP_USD)

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

// generation_runs has one status column for the whole run, not per TC (see
// migrate.js's own note: a generation_run_test_cases join table is the
// documented upgrade path if per-TC progress is ever needed). Re-sending an
// already-current status is harmless but pointless SSE noise, so each phase
// is only reported the first time the run enters it.
const reportedPhases = new Set()
async function reportPhaseOnce(status) {
  if (reportedPhases.has(status)) return
  reportedPhases.add(status)
  await reportEvent(status)
}

let totalCostUsd = 0
class CostCapExceededError extends Error {}

// Invokes a named subagent headlessly and returns its parsed JSON result.
// Cost is checked AFTER each call completes (there's no mid-run cost hook)
// and accumulated across the whole script run; going over aborts whatever
// comes next rather than killing an in-flight call.
async function runAgent(prompt) {
  const { stdout } = await execFileAsync('npx', [
    'claude', '-p', prompt,
    '--permission-mode', 'dontAsk',
    '--output-format', 'json',
  ], { maxBuffer: 1024 * 1024 * 50 })

  const result = JSON.parse(stdout)
  if (typeof result.total_cost_usd === 'number') totalCostUsd += result.total_cost_usd
  console.log(`  cost this call: $${result.total_cost_usd ?? '?'}, running total: $${totalCostUsd.toFixed(4)}`)

  if (totalCostUsd > COST_CAP) {
    throw new CostCapExceededError(`Generation cost cap ($${COST_CAP}) exceeded — spent $${totalCostUsd.toFixed(2)} so far`)
  }
  if (result.permission_denials?.length) {
    // A denied tool call means .claude/settings.json's allowlist is missing
    // something this phase needed — surface it distinctly from a normal
    // agent failure so it's obvious the fix is in settings.json, not AGENTS.md.
    throw new Error(`Agent hit ${result.permission_denials.length} permission denial(s): ${JSON.stringify(result.permission_denials).slice(0, 500)}`)
  }
  if (result.is_error) {
    throw new Error(`Agent invocation reported an error: ${result.result || '(no message)'}`)
  }
  return result
}

function runPlaywrightTest(targetDir) {
  return new Promise(resolve => {
    execFile('npx', ['playwright', 'test', targetDir, '--project=generated'], (error) => {
      resolve(!error) // true = all passed, false = at least one failure
    })
  })
}

async function main() {
  const payload = JSON.parse(fs.readFileSync('.generation-payload.json', 'utf-8'))
  const { suite_slug: suiteSlug, target_url: targetUrl, plans } = payload
  const suiteDir = path.join('tests', 'generated', suiteSlug)
  fs.mkdirSync(suiteDir, { recursive: true })

  const entries = plans.map(plan => ({
    ...plan,
    specPath: path.join(suiteDir, plan.filename.replace(/\.md$/, '.spec.ts')),
  }))

  // Both phases below batch every plan into ONE agent invocation instead of
  // one call per TC. Each `claude -p` call repays a fixed ~$0.15-0.25
  // overhead just to load AGENTS.md/tool definitions before doing any real
  // work — with N TCs per run, that was N times the fixed cost for no
  // benefit. Batching amortizes it across the whole run.
  //
  // The tradeoff: a hard failure (is_error, permission denial, cost cap) in
  // a batched call can't be pinned to one specific TC, since one invocation
  // now covers all of them — so a hard failure here fails every TC in the
  // batch, not just one. A TC-specific problem that the agent itself can
  // route around (e.g. a plan flagged "blocked" by planExport.js) is NOT a
  // hard failure — the agent just doesn't produce that one file, which the
  // per-TC file-existence check below still catches correctly. So per-TC
  // outcomes stay accurate for the common case; only a systemic failure
  // (not a single-TC content problem) loses isolation.
  try {
    const plannerList = entries.map(e => `- specs/${e.filename}`).join('\n')
    await runAgent(
      `Use the playwright-test-planner agent to verify and refine EACH of the following plans against the running app at ${targetUrl}, following AGENTS.md conventions. Update each file in place only if changes are needed. Process every plan in this list before finishing:\n${plannerList}`
    )
  } catch (err) {
    if (err instanceof CostCapExceededError) throw err
    const msg = `Planner batch failed, no TCs could be verified: ${err.message}`
    await reportEvent('failed', { error_message: msg.slice(0, 2000) })
    console.error(msg)
    process.exit(1)
  }

  await reportPhaseOnce('generating')

  try {
    const generatorList = entries.map(e => `- specs/${e.filename} -> ${e.specPath}`).join('\n')
    await runAgent(
      `Use the playwright-test-generator agent to implement EACH of the following plans as its corresponding spec file, following AGENTS.md conventions. Process every entry in this list:\n${generatorList}`
    )
  } catch (err) {
    if (err instanceof CostCapExceededError) throw err
    // Don't bail immediately — some specs may have been written before the
    // failure. Fall through to the per-TC file check below to find out.
    console.error('Generator batch reported an error, checking what actually got written:', err.message)
  }

  // Primary success signal is each file existing on disk, independent of
  // whatever the agent's own stdout claims happened — this is what still
  // gives us accurate per-TC outcomes despite the batched call above.
  const results = entries.map(e => fs.existsSync(e.specPath)
    ? { tc_id: e.tc_id, specPath: e.specPath, success: true }
    : { tc_id: e.tc_id, specPath: e.specPath, success: false, error: 'generator did not produce this file' })

  for (const r of results) {
    if (!r.success) console.error(`TC ${r.tc_id} failed to generate: ${r.error}`)
  }

  const succeeded = results.filter(r => r.success)
  if (succeeded.length === 0) {
    const combined = results.map(r => `TC ${r.tc_id}: ${r.error}`).join('; ')
    await reportEvent('failed', { error_message: `No test cases generated successfully. ${combined}`.slice(0, 2000) })
    console.error('Nothing generated — failing the run.')
    process.exit(1)
  }

  await reportPhaseOnce('healing')
  let clean = await runPlaywrightTest(suiteDir)
  for (let attempt = 1; attempt <= 3 && !clean; attempt++) {
    console.log(`Heal attempt ${attempt}/3`)
    await runAgent(
      `Use the playwright-test-healer agent to fix any failing tests in ${suiteDir}, following AGENTS.md conventions. Do not weaken assertions — if a failure means app behavior changed rather than the test being wrong, mark it with test.fixme() and a POSSIBLE REGRESSION comment instead of forcing it to pass.`
    )
    clean = await runPlaywrightTest(suiteDir)
  }
  if (!clean) {
    console.warn('Heal loop exhausted (3 attempts) with tests still failing — proceeding to PR anyway (a flagged failure is still reviewable, per AGENTS.md healing rules).')
  }

  // Script's job ends here. The workflow's next steps (peter-evans/create-pull-request,
  // then a final generation-events call with the real pr_url/branch_name) run
  // outside this script — only it knows the PR URL once the PR actually exists.
  await reportPhaseOnce('opening_pr')
  console.log(`Done. ${succeeded.length}/${plans.length} test case(s) generated. Handing off to the PR step.`)
}

main().catch(async err => {
  console.error('Generation run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  process.exit(1)
})
