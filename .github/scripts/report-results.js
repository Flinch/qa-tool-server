import fs from 'fs'
import https from 'https'
import http from 'http'

const {
  SUITE_SLUG, TRIGGER_TYPE, RUN_CORRELATION_ID, PROJECT_ID,
  REPORT_URL, GITHUB_RUN_URL, WEBHOOK_URL, WEBHOOK_SECRET,
} = process.env

function walkSuites(suites, out) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const result = test.results?.[test.results.length - 1] || {}
        out.push({
          test_title: spec.title,
          status: result.status === 'passed' ? 'passed' : result.status === 'skipped' ? 'skipped' : 'failed',
          duration_ms: Math.round(result.duration || 0),
          error_message: result.error?.message || null,
        })
      }
    }
    walkSuites(suite.suites, out)
  }
}

function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const url = new URL(WEBHOOK_URL)
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
        res.statusCode >= 400 ? reject(new Error(`Webhook returned ${res.statusCode}`)) : resolve()
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

const basePayload = {
  correlation_id: RUN_CORRELATION_ID || null,
  project_id: Number(PROJECT_ID),
  suite_slug: SUITE_SLUG,
  trigger_type: TRIGGER_TYPE,
  report_url: REPORT_URL,
  github_run_url: GITHUB_RUN_URL,
}

let report
try {
  report = JSON.parse(fs.readFileSync('results.json', 'utf-8'))
} catch (e) {
  // No results file means Playwright never finished (install failed, the
  // runner crashed, etc.) — tell the app the run failed instead of leaving
  // its test_runs row stuck on 'pending' forever with no explanation.
  console.error('Could not read results.json:', e.message)
  await sendWebhook({
    ...basePayload,
    status: 'failed',
    error_message: `Test run did not produce results: ${e.message}`,
    results: [],
  }).catch(err => console.error('Webhook request failed:', err.message))
  process.exit(1)
}

const results = []
walkSuites(report.suites, results)

const payload = {
  ...basePayload,
  status: 'completed',
  total: results.length,
  passed: results.filter(r => r.status === 'passed').length,
  failed: results.filter(r => r.status === 'failed').length,
  skipped: results.filter(r => r.status === 'skipped').length,
  duration_ms: Math.round(report.stats?.duration || 0),
  results,
}

try {
  await sendWebhook(payload)
} catch (err) {
  console.error('Webhook request failed:', err.message)
  process.exit(1)
}