import https from 'https'
import http from 'http'

const { CORRELATION_ID, WEBHOOK_BASE_URL, WEBHOOK_SECRET, PR_URL, BRANCH_NAME } = process.env

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
      res.on('end', () => {
        console.log(`generation-events -> ${res.statusCode}: ${data}`)
        res.statusCode >= 400 ? reject(new Error(`Webhook returned ${res.statusCode}`)) : resolve()
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

// Only the workflow (not generate-tests.js) knows the real PR URL — this
// runs as the step right after peter-evans/create-pull-request, reporting
// the terminal 'completed' event the script itself deliberately doesn't send.
await postJson(`${WEBHOOK_BASE_URL}/generation-events`, WEBHOOK_SECRET, {
  correlation_id: CORRELATION_ID,
  status: 'completed',
  pr_url: PR_URL || null,
  branch_name: BRANCH_NAME || null,
})
