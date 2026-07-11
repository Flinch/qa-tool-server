import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

const { CORRELATION_ID, WEBHOOK_BASE_URL, WEBHOOK_SECRET } = process.env

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

if (!CORRELATION_ID || !WEBHOOK_BASE_URL || !WEBHOOK_SECRET) {
  console.error('CORRELATION_ID, WEBHOOK_BASE_URL, and WEBHOOK_SECRET are required')
  process.exit(1)
}

try {
  const payload = await getJson(`${WEBHOOK_BASE_URL}/generation-payload/${CORRELATION_ID}`, WEBHOOK_SECRET)

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
