// Runs `maestro test` for real against whatever device is connected, parses
// its JUnit output, and POSTs into the exact same webhook contract
// .github/scripts/report-results.js already uses for the web pipeline
// (POST /webhooks/test-runs) — proving the endpoint really is hosting-
// agnostic: it doesn't matter whether the run happened locally (this
// script), a self-hosted runner, Device Farm, or Maestro Cloud, as long as
// something produces this same payload shape.
//
// Callable two ways: by hand locally (positional args only, no
// RUN_CORRELATION_ID/TRIGGER_TYPE/GITHUB_RUN_URL set — results land as a
// fresh INSERT per webhooks.js), or from .github/workflows/maestro-run.yml
// on the self-hosted runner (same positional args, plus those three env
// vars set so the result UPDATEs the pending row triggerSuiteRun inserted).
//
// Usage:
//   node scripts/report-mobile-results.js <flows-dir> <suite-slug> <project-id>
//
// Required env: WEBHOOK_BASE_URL, WEBHOOK_SECRET (same as the web pipeline's
// GitHub Actions secrets — read from a local .env for manual runs).
// Optional env: RUN_CORRELATION_ID, TRIGGER_TYPE (defaults to 'manual'),
// GITHUB_RUN_URL.

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { XMLParser } from 'fast-xml-parser'
import https from 'https'
import http from 'http'
import { buildHtmlReport } from './buildMobileReport.js'

const [, , flowsDir, suiteSlug, projectIdArg] = process.argv
const { WEBHOOK_BASE_URL, WEBHOOK_SECRET, RUN_CORRELATION_ID, TRIGGER_TYPE, GITHUB_RUN_URL, REPORT_URL, REPORT_OUTPUT_DIR } = process.env

if (!flowsDir || !suiteSlug || !projectIdArg) {
  console.error('Usage: node scripts/report-mobile-results.js <flows-dir> <suite-slug> <project-id>')
  process.exit(1)
}
if (!WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('WEBHOOK_BASE_URL and WEBHOOK_SECRET are required')
  process.exit(1)
}

const projectId = Number(projectIdArg)
const correlationId = RUN_CORRELATION_ID || null
const triggerType = TRIGGER_TYPE || 'manual'

// This runner handles both platforms, so an iOS Simulator and an Android
// device/emulator can be connected at the same time. Without -p/--platform,
// maestro's device auto-selection is ambiguous across the two and can pick
// the wrong one outright (confirmed: an iOS flow run this way failed with
// "Package ... is not installed" — not because it wasn't installed, but
// because maestro had picked the connected Android device instead). Derived
// from flowsDir (tests/generated-mobile/<platform>/<suite-slug>) rather than
// adding a new required arg, so the existing by-hand usage keeps working.
const platform = flowsDir.split('/').find((seg, i, arr) => arr[i - 1] === 'generated-mobile')
if (!platform) {
  console.error(`Could not determine platform from flows dir "${flowsDir}" (expected tests/generated-mobile/<platform>/<suite-slug>)`)
  process.exit(1)
}
const junitPath = path.join('/tmp', `maestro-${suiteSlug}-results.xml`)
// Fixed path, reused across every run of this suite — cleared first so a run
// that fails before maestro ever writes output (e.g. "0 devices connected")
// can't silently report a PRIOR run's real results as if they were fresh.
// Confirmed this happened for real: a run with no Android device attached
// still reported "2 passed, 1 failed" — an old results file from an earlier,
// device-attached run was still sitting at this path and got parsed as-is.
fs.rmSync(junitPath, { force: true })
// Fixed + flattened (not the default timestamped ~/.maestro/tests/<ts>/) so
// this run's screenshots are unambiguous to find afterward — cleared first
// so a stale file from a previous run can never be mistaken for this one's.
const debugOutputDir = path.join('/tmp', `maestro-debug-${suiteSlug}`)
fs.rmSync(debugOutputDir, { recursive: true, force: true })
fs.mkdirSync(debugOutputDir, { recursive: true })

// Directory (not a single file) so it can be handed straight to a static
// host's publish step (mirrors playwright.yml's publish_dir) — same
// clear-before-write reasoning as junitPath/debugOutputDir above.
const reportDir = REPORT_OUTPUT_DIR || path.join('/tmp', `maestro-report-${suiteSlug}`)
fs.rmSync(reportDir, { recursive: true, force: true })
fs.mkdirSync(reportDir, { recursive: true })

// Maestro auto-saves a screenshot at the moment of failure, named
// screenshot-❌-<timestamp>-(<flow name>).png — no extra flags needed beyond
// pointing --debug-output somewhere we can find it.
function findScreenshotBase64(testTitle) {
  try {
    const match = fs.readdirSync(debugOutputDir)
      .find(f => f.startsWith('screenshot-') && f.endsWith(`(${testTitle}).png`))
    return match ? fs.readFileSync(path.join(debugOutputDir, match)).toString('base64') : null
  } catch {
    return null
  }
}

function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const url = new URL(`${WEBHOOK_BASE_URL}/test-runs`)
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': WEBHOOK_SECRET,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        console.log(`Webhook responded ${res.statusCode}: ${data}`)
        res.statusCode >= 400 ? reject(new Error(`Webhook returned ${res.statusCode}: ${data}`)) : resolve(JSON.parse(data))
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Real status values confirmed by hand against this session's device:
// passing testcases are self-closing with status="SUCCESS"; failing ones
// have status="ERROR" (not "FAILED") and a <failure> child with the message
// as text content. No <skipped> case observed yet — Maestro's tag exclusion
// appears to omit excluded flows from the report entirely rather than
// marking them skipped, but mapped defensively below in case that's
// version-dependent.
function statusToResult(status) {
  if (status === 'SUCCESS') return 'passed'
  if (status === 'SKIPPED') return 'skipped'
  return 'failed'
}

console.log(`Running maestro test against ${flowsDir} (platform: ${platform})...`)
try {
  execFileSync('maestro', [
    '--platform', platform,
    'test', flowsDir,
    '--format', 'junit', '--output', junitPath,
    '--debug-output', debugOutputDir, '--flatten-debug-output',
  ], {
    stdio: 'inherit',
    env: { ...process.env, PATH: `${process.env.HOME}/.maestro/bin:/opt/homebrew/opt/openjdk/bin:${process.env.PATH}` },
  })
} catch (err) {
  // maestro test exits non-zero when flows fail — that's expected and not a
  // script error; the JUnit file is still written in that case. But it also
  // exits non-zero for real infra failures (no device connected) that never
  // write a file at all — log it so that distinction is visible instead of
  // silently swallowed, which is exactly what let the stale-results bug
  // above go unnoticed.
  console.error('maestro test exited non-zero:', err.message)
}

if (!fs.existsSync(junitPath)) {
  const message = `maestro test did not produce a results file at ${junitPath} — no device connected, or the run crashed before producing output`
  console.error(message)
  await sendWebhook({
    correlation_id: correlationId,
    project_id: projectId,
    suite_slug: suiteSlug,
    trigger_type: triggerType,
    github_run_url: GITHUB_RUN_URL,
    status: 'failed',
    error_message: message,
    results: [],
  }).catch(err => console.error('Webhook request failed:', err.message))
  process.exit(1)
}

const xml = fs.readFileSync(junitPath, 'utf-8')
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' })
const parsed = parser.parse(xml)

const suite = parsed.testsuites?.testsuite
const rawCases = suite ? (Array.isArray(suite.testcase) ? suite.testcase : suite.testcase ? [suite.testcase] : []) : []

const results = rawCases.map(tc => {
  const status = tc['@_status']
  const resultStatus = statusToResult(status)
  const failureNode = tc.failure
  const errorMessage = failureNode != null
    ? (typeof failureNode === 'string' ? failureNode : failureNode['#text'] || null)
    : null
  return {
    test_title: tc['@_name'],
    status: resultStatus,
    duration_ms: tc['@_time'] != null ? Math.round(Number(tc['@_time']) * 1000) : null,
    error_message: errorMessage,
    screenshot_base64: resultStatus === 'failed' ? findScreenshotBase64(tc['@_name']) : null,
  }
})

// Written locally either way (useful when running by hand); only reported
// upward via report_url when REPORT_URL is set, i.e. when maestro-run.yml's
// gh-pages deploy step is actually going to publish this directory.
fs.writeFileSync(path.join(reportDir, 'index.html'), buildHtmlReport({ suiteSlug, platform, results }))
console.log(`Wrote HTML report to ${path.join(reportDir, 'index.html')}`)

const payload = {
  correlation_id: correlationId, // null for a manual local run, real for a CI-dispatched one
  project_id: projectId,
  suite_slug: suiteSlug,
  trigger_type: triggerType,
  report_url: REPORT_URL || null,
  github_run_url: GITHUB_RUN_URL,
  status: 'completed',
  total: results.length,
  passed: results.filter(r => r.status === 'passed').length,
  failed: results.filter(r => r.status === 'failed').length,
  skipped: results.filter(r => r.status === 'skipped').length,
  duration_ms: suite?.['@_time'] != null ? Math.round(Number(suite['@_time']) * 1000) : null,
  results,
}

console.log('Reporting:', JSON.stringify({
  ...payload,
  results: payload.results.map(r => ({ ...r, screenshot_base64: r.screenshot_base64 ? `<${r.screenshot_base64.length} chars>` : null })),
}, null, 2))
await sendWebhook(payload)
