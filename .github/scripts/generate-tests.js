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

// Formatted agent-step lines, flushed periodically to POST
// /generation-logs so the app can show a live terminal feed instead of
// only the GH Actions log — see printStreamEvent below for what gets
// pushed here. Same buffer-then-flush shape copied into every one of the
// 5 generation/heal scripts (see heal-test.js's own comment on why this is
// duplicated rather than a shared lib).
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

// One line per stream-json event so both the live GitHub Actions log AND
// the app's log viewer show the agent's tool calls and reasoning as they
// happen, instead of nothing until the whole multi-minute turn completes
// (the old buffered --output-format json gave no visibility at all until
// the process exited). Deliberately terse (one line per block, hard-
// truncated) — same convention already proven in generate-mobile-tests.js.
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

// Runs `npx claude -p ...` with a hard wall-clock timeout that kills the
// WHOLE process tree, not just the immediate child. This matters because a
// hang was observed firsthand: cancelling a stuck run showed GitHub Actions
// having to individually clean up orphaned `claude`, `npm exec
// playwright run-test-mcp-server`, and `chrome-headless-shell` processes —
// npx/claude/the MCP server/the browser form a multi-level process tree, and
// a plain SIGTERM to the top process doesn't reliably cascade down through
// all of it. `detached: true` makes the child the leader of its own process
// group, so `process.kill(-pid, ...)` (negative pid = the whole group)
// reaches every descendant in one signal.
//
// Streams stdout line-by-line (stream-json is one JSON object per line)
// instead of buffering the whole call like the old execFile-based version
// did — ported from generate-mobile-tests.js's proven implementation. The
// final `result` event carries the exact same fields (total_cost_usd/
// is_error/permission_denials/result) the old buffered `--output-format
// json` mode returned, so runAgent below barely changes.
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
      reject(new AgentTimeoutError(`Agent invocation timed out after ${timeout}ms and was killed — likely stuck on a browser action that never resolved (confirmed possible: a prior hang left the browser and MCP server processes still alive after the whole claude process should have exited).`))
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

// Invokes a named subagent headlessly and returns its parsed JSON result.
// Cost is checked AFTER each call completes (there's no mid-run cost hook)
// and accumulated across the whole script run; going over aborts whatever
// comes next rather than killing an in-flight call.
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
  const { suite_slug: suiteSlug, target_url: targetUrl, api_base_url: apiBaseUrl, engine, plans, helpers_dir: helpersDir } = payload
  const suiteDir = path.join('tests', 'generated', suiteSlug)
  fs.mkdirSync(suiteDir, { recursive: true })

  // API suites (engine='api') get a different agent trio — no browser
  // involved, verification is curl/fetch over Bash instead of
  // mcp__playwright-test__browser_* tools. See AGENTS.md's "API tests"
  // section for the full conventions these agents follow.
  const isApi = engine === 'api'
  const agents = isApi
    ? { planner: 'api-test-planner', generator: 'api-test-generator', healer: 'api-test-healer' }
    : { planner: 'playwright-test-planner', generator: 'playwright-test-generator', healer: 'playwright-test-healer' }
  const conventions = isApi ? "AGENTS.md's \"API tests\" section" : 'AGENTS.md conventions'

  // Per-project reusable helpers (see AGENTS.md's "Per-project reusable
  // helpers" section) — web pipeline only, and only for a project with its
  // own custom target (helpersDir is null for the original demo project,
  // which keeps its existing flat helpers/ convention and prompt wording
  // completely unchanged below).
  const generatorHelperInstruction = (!isApi && helpersDir)
    ? ` Check ${helpersDir}/ via Glob + Read first for existing reusable helpers before implementing a step from scratch. If you have to live-verify and implement a step that's a genuinely reusable setup/entry action for this app (not a one-off), also extract it into a new file under ${helpersDir}/ — one exported async function taking page, a one-line top comment describing what it does, same shape as helpers/createTicket.ts — following AGENTS.md's "Per-project reusable helpers" section.`
    : ''
  const healerHelperInstruction = (!isApi && helpersDir)
    ? ` This project has reusable helpers under ${helpersDir}/ — feel free to use an existing one while fixing a test, but don't create new ones during a heal.`
    : ''

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
  // The two planners are fundamentally different beasts now: the API
  // planner still live-verifies with curl (cheap HTTP calls, worth the
  // signal), but the WEB planner is deliberately browserless — a real run
  // showed its live walkthrough duplicating the generator's at ~$5/run for
  // no added signal, so it now reviews plans against the repo only
  // (helpers, prior specs, conventions) and the generator's single live
  // walkthrough is the ground truth. See AGENTS.md's Behavior mismatch
  // policy: live contradictions are discovered and flagged at
  // generation/healing, not planning.
  try {
    const plannerList = entries.map(e => `- specs/${e.filename}`).join('\n')
    const plannerPrompt = isApi
      ? `Use the ${agents.planner} agent to verify and refine EACH of the following plans against the real API at ${apiBaseUrl}, following ${conventions}. Update each file in place only if changes are needed. Process every plan in this list before finishing:\n${plannerList}\n\nIf a plan step is fully covered by an existing helper (see AGENTS.md's helpers list), you don't need to re-verify that step live — it's already a proven, working part of the codebase. Focus live verification on steps that aren't already covered by a helper.\n\nIf a plan's stated Expect: outcome turns out to be genuinely contradicted by the API's real behavior (not a wording issue — it actually does something different from what's described), do NOT keep retrying or waiting for the expected state to appear. Follow AGENTS.md's Behavior mismatch policy: note it directly in the plan file with a BEHAVIOR MISMATCH comment describing expected vs actual, and move on to the next plan.`
      : `Use the ${agents.planner} agent to review and refine EACH of the following plans using the repo ONLY, following ${conventions}. Do NOT attempt to browse or verify against the live app — the generator does the single live walkthrough afterward and is the ground truth for selectors and behavior. Work from: existing helpers (${helpersDir ? `${helpersDir}/ for this project, plus the flat helpers/` : 'the flat helpers/ directory'}), prior generated specs in tests/generated/${suiteSlug}/, and AGENTS.md. Annotate any plan step already fully covered by an existing helper so the generator reuses it instead of live-exploring it. Tighten vague steps and Expect lines, flag blocked plans, and update each file in place only if changes are genuinely needed, preserving the plan format exactly. Process every plan in this list before finishing:\n${plannerList}`
    await runAgent(plannerPrompt)
  } catch (err) {
    if (err instanceof CostCapExceededError) throw err
    const msg = `Planner batch failed, no TCs could be verified: ${err.message}`
    await reportEvent('failed', { error_message: msg.slice(0, 2000) })
    console.error(msg)
    process.exit(1)
  }

  await reportPhaseOnce('generating')

  // Set when the generator phase hit its cost cap or timed out — both cases
  // skip the heal loop below (no point spending/waiting further after
  // either), but still retain whatever files actually got written.
  let skipHealing = false
  try {
    const generatorList = entries.map(e => `- specs/${e.filename} -> ${e.specPath}`).join('\n')
    await runAgent(
      `Use the ${agents.generator} agent to implement EACH of the following plans as its corresponding spec file, following ${conventions}. Process every entry in this list:\n${generatorList}${generatorHelperInstruction}`
    )
  } catch (err) {
    // Don't bail immediately — some specs may have been written before the
    // failure. On a cost cap, the batched call already ran to completion by
    // the time cost is known (no mid-call hook), so whatever it wrote is
    // really on disk. On a timeout, the process was killed mid-flight, so a
    // partially-written file is possible but not guaranteed — the
    // file-existence check below is still the right signal either way: if
    // generator_write_test finished for a TC before the kill, that file is
    // real and complete; if it didn't, the file simply won't exist.
    if (err instanceof CostCapExceededError || err instanceof AgentTimeoutError) skipHealing = true
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
    const prefix = skipHealing ? 'Generation was cut short (cost cap or timeout) and nothing was generated successfully. ' : 'No test cases generated successfully. '
    await reportEvent('failed', { error_message: `${prefix}${combined}`.slice(0, 2000) })
    console.error('Nothing generated — failing the run.')
    process.exit(1)
  }

  if (skipHealing) {
    console.warn(`Generation was cut short (cost cap or timeout) — skipping the heal loop. Proceeding to PR with ${succeeded.length}/${entries.length} test case(s) as generated (unhealed).`)
  } else {
    await reportPhaseOnce('healing')
    let clean = await runPlaywrightTest(suiteDir)
    for (let attempt = 1; attempt <= 3 && !clean; attempt++) {
      console.log(`Heal attempt ${attempt}/3`)
      await runAgent(
        `Use the ${agents.healer} agent to fix any failing tests in ${suiteDir}, following ${conventions}. Do not weaken assertions — if a failure means ${isApi ? 'API' : 'app'} behavior changed rather than the test being wrong, mark it with test.fixme() and a POSSIBLE REGRESSION comment instead of forcing it to pass.${healerHelperInstruction}`
      )
      clean = await runPlaywrightTest(suiteDir)
    }
    if (!clean) {
      console.warn('Heal loop exhausted (3 attempts) with tests still failing — proceeding to PR anyway (a flagged failure is still reviewable, per AGENTS.md healing rules).')
    }
  }

  // Script's job ends here. The workflow's next steps (peter-evans/create-pull-request,
  // then a final generation-events call with the real pr_url/branch_name) run
  // outside this script — only it knows the PR URL once the PR actually exists.
  await reportPhaseOnce('opening_pr')
  console.log(`Done. ${succeeded.length}/${plans.length} test case(s) generated. Handing off to the PR step.`)
}

main().then(async () => {
  clearInterval(logFlushInterval)
  await flushLogs()
  // Explicit exit is necessary, not cosmetic: observed firsthand that the
  // process hung indefinitely after this point on a real run (the "Done"
  // line printed, but the "Generate and heal tests" step never completed).
  // The webhook POSTs in postJson/reportEvent use Node's default
  // keep-alive HTTP agent, which can leave a socket handle open and the
  // event loop alive even with nothing left to do.
  process.exit(0)
}).catch(async err => {
  console.error('Generation run failed:', err.message)
  await reportEvent('failed', { error_message: err.message.slice(0, 2000) }).catch(() => {})
  clearInterval(logFlushInterval)
  await flushLogs().catch(() => {})
  process.exit(1)
})
