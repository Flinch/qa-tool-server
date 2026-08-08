import fs from 'fs'
import https from 'https'
import http from 'http'

// Web-only. Confirmed by reading every mobile workflow (maestro-run.yml,
// heal-mobile-test.yml): they run already-generated Maestro flows against
// an already-connected device with the app id baked into the flow YAML at
// generation time — no TARGET_URL/credentials concept applies there at
// all. This step is wired into playwright.yml, heal-test.yml, and
// generate-auth-setup.yml.
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
        if (res.statusCode >= 400) return reject(new Error(`Run-config fetch returned ${res.statusCode}: ${data}`))
        resolve(JSON.parse(data))
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function writeEnv(config) {
  const lines = []
  // Real login secrets, fetched at runtime rather than from a registered
  // `secrets.*` context — GitHub's automatic log redaction only knows about
  // the latter, so without an explicit ::add-mask:: these two print in
  // plaintext in every step's default env-dump log header (confirmed for
  // real: a run's log showed the actual password verbatim). add-mask must
  // run before the value ever gets echoed anywhere, so it's emitted here,
  // ahead of the GITHUB_ENV write below.
  if (config.test_credentials?.username) console.log(`::add-mask::${config.test_credentials.username}`)
  if (config.test_credentials?.password) console.log(`::add-mask::${config.test_credentials.password}`)

  if (config.target_url) lines.push(`TARGET_URL=${config.target_url}`)
  if (config.api_base_url) lines.push(`API_BASE_URL=${config.api_base_url}`)
  if (config.test_credentials?.username) lines.push(`TEST_USER_NAME=${config.test_credentials.username}`)
  if (config.test_credentials?.password) lines.push(`TEST_USER_PASSWORD=${config.test_credentials.password}`)
  if (config.test_credentials?.displayName) lines.push(`TEST_USER_DISPLAY_NAME=${config.test_credentials.displayName}`)
  if (config.auth_setup_file) lines.push(`AUTH_SETUP_FILE=${config.auth_setup_file}`)
  // Previously unused by every existing (web-only) caller of this script —
  // additive for explore-mobile-app.yml, which needs the resolved app id
  // and has no plan-fetching payload of its own to carry it instead.
  if (config.app_id) lines.push(`APP_ID=${config.app_id}`)

  if (lines.length === 0) return
  if (GITHUB_ENV) {
    fs.appendFileSync(GITHUB_ENV, lines.join('\n') + '\n')
  } else {
    // Local/dev fallback — GITHUB_ENV only exists inside a real Actions
    // runner. Print instead of silently doing nothing so a local run of
    // this script is still useful for debugging.
    console.log('GITHUB_ENV not set (not running in Actions?) — would have written:\n' + lines.join('\n'))
  }
}

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
  process.exit(1)
}

try {
  const config = await getJson(`${WEBHOOK_BASE_URL}/run-config/${CORRELATION_ID}`, WEBHOOK_SECRET)
  writeEnv(config)
  console.log(`Fetched test environment for correlation ${CORRELATION_ID}: target_url=${config.target_url || '(default)'}`)
} catch (err) {
  console.error('Failed to fetch test environment config:', err.message)
  process.exit(1)
}
