import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

const { CORRELATION_ID, WEBHOOK_BASE_URL, WEBHOOK_SECRET, GITHUB_ENV } = process.env

function getJson(url, secret) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(u, {
      method: 'GET',
      headers: { 'x-webhook-secret': secret },
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Payload fetch returned ${res.statusCode}: ${data}`))
        resolve(JSON.parse(data))
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function postJson(url, secret, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const payload = JSON.stringify(body)
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': secret,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, data }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// Web-only (target_url/test_credentials are only meaningful for the
// Playwright pipeline — mobile generation reads app_id straight off the
// payload object, not an env var, since there's no storageState/Authenticate
// step to feed). Harmless no-op for a mobile payload, which just won't have
// these fields.
function writeEnv(payload) {
  const lines = []
  if (payload.target_url) lines.push(`TARGET_URL=${payload.target_url}`)
  if (payload.api_base_url) lines.push(`API_BASE_URL=${payload.api_base_url}`)
  if (payload.test_credentials?.username) lines.push(`TEST_USER_NAME=${payload.test_credentials.username}`)
  if (payload.test_credentials?.password) lines.push(`TEST_USER_PASSWORD=${payload.test_credentials.password}`)
  if (payload.test_credentials?.displayName) lines.push(`TEST_USER_DISPLAY_NAME=${payload.test_credentials.displayName}`)
  if (payload.auth_setup_file) lines.push(`AUTH_SETUP_FILE=${payload.auth_setup_file}`)

  if (lines.length === 0) return
  if (GITHUB_ENV) {
    fs.appendFileSync(GITHUB_ENV, lines.join('\n') + '\n')
  } else {
    console.log('GITHUB_ENV not set (not running in Actions?) — would have written:\n' + lines.join('\n'))
  }
}

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
  process.exit(1)
}

try {
  const payload = await getJson(`${WEBHOOK_BASE_URL}/generation-payload/${CORRELATION_ID}`, WEBHOOK_SECRET)
  writeEnv(payload)

  fs.mkdirSync('specs', { recursive: true })
  for (const plan of payload.plans) {
    fs.writeFileSync(path.join('specs', plan.filename), plan.markdown)
  }

  // Hand the payload off to generate-tests.js as a small local file rather
  // than re-fetching it or piping through stdout between workflow steps.
  fs.writeFileSync('.generation-payload.json', JSON.stringify(payload, null, 2))

  console.log(`Fetched payload: ${payload.plans.length} plan(s) for suite "${payload.suite_slug}"`)
} catch (err) {
  console.error('Failed to fetch generation payload:', err.message)
  await postJson(`${WEBHOOK_BASE_URL}/generation-events`, WEBHOOK_SECRET, {
    correlation_id: CORRELATION_ID,
    status: 'failed',
    error_message: `Could not fetch generation payload: ${err.message}`,
  }).catch(e => console.error('Also failed to report the failure:', e.message))
  process.exit(1)
}
