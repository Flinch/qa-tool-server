// Provisions and runs a Maestro flow suite on AWS Device Farm, then parses
// the results into the same {total,passed,failed,results[]} shape
// .github/scripts/report-results.js already POSTs to the webhook — so this
// drops into the existing contract unchanged.
//
// NOT YET RUN against a live account (see mobile-spike/FINDINGS.md — no AWS
// account existed during this spike). Requires `npm install
// @aws-sdk/client-device-farm` (not yet added to package.json — deliberately
// not added by this spike since it's an unused dependency until Phase 1
// actually wires this in; see mobile-spike/AWS-SETUP-RUNBOOK.md).
//
// Usage: node mobile-spike/scripts/device-farm-run.js
// Required env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
//   DEVICE_FARM_PROJECT_ARN, DEVICE_FARM_DEVICE_POOL_ARN, APP_BINARY_PATH,
//   FLOWS_DIR (defaults to mobile-spike/flows/hierarchy-assisted)

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import https from 'https'
import {
  DeviceFarmClient,
  CreateUploadCommand,
  GetUploadCommand,
  ScheduleRunCommand,
  GetRunCommand,
  ListArtifactsCommand,
} from '@aws-sdk/client-device-farm'

const {
  AWS_REGION,
  DEVICE_FARM_PROJECT_ARN,
  DEVICE_FARM_DEVICE_POOL_ARN,
  APP_BINARY_PATH,
  FLOWS_DIR = 'mobile-spike/flows/hierarchy-assisted',
} = process.env

if (!DEVICE_FARM_PROJECT_ARN || !DEVICE_FARM_DEVICE_POOL_ARN || !APP_BINARY_PATH) {
  console.error('DEVICE_FARM_PROJECT_ARN, DEVICE_FARM_DEVICE_POOL_ARN, and APP_BINARY_PATH are required')
  process.exit(1)
}

const client = new DeviceFarmClient({ region: AWS_REGION || 'us-west-2' })

function putFile(uploadUrl, filePath) {
  return new Promise((resolve, reject) => {
    const body = fs.readFileSync(filePath)
    const url = new URL(uploadUrl)
    const req = https.request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
    }, res => {
      res.statusCode >= 400 ? reject(new Error(`Upload PUT returned ${res.statusCode}`)) : resolve()
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function createAndWaitForUpload(name, type, filePath) {
  const { upload } = await client.send(new CreateUploadCommand({
    projectArn: DEVICE_FARM_PROJECT_ARN,
    name,
    type,
  }))
  await putFile(upload.url, filePath)

  // Device Farm processes the upload asynchronously (virus scan, format
  // validation) before it's usable in a run — poll until it leaves
  // INITIALIZED/PROCESSING.
  let current = upload
  while (current.status === 'INITIALIZED' || current.status === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 5000))
    const res = await client.send(new GetUploadCommand({ arn: upload.arn }))
    current = res.upload
  }
  if (current.status !== 'SUCCEEDED') {
    throw new Error(`Upload "${name}" failed: ${current.status} ${current.message || ''}`)
  }
  return current.arn
}

function zipFlowsDir(dir) {
  const zipPath = path.join('/tmp', 'maestro-flows.zip')
  fs.rmSync(zipPath, { force: true })
  // Device Farm's test package upload expects a zip with the test files at
  // its root — zip from inside the flows dir so paths inside match what
  // device-farm-test-spec.yml's `test` phase expects at
  // $DEVICEFARM_TEST_PACKAGE_PATH/flows.
  execSync(`mkdir -p /tmp/maestro-package/flows && cp -R "${dir}"/* /tmp/maestro-package/flows/ && cd /tmp/maestro-package && zip -r "${zipPath}" flows`)
  return zipPath
}

async function main() {
  console.log('Uploading app binary...')
  const appArn = await createAndWaitForUpload(path.basename(APP_BINARY_PATH), 'ANDROID_APP', APP_BINARY_PATH)

  console.log('Uploading test spec...')
  const specArn = await createAndWaitForUpload('device-farm-test-spec.yml', 'APPIUM_NODE_TEST_SPEC', 'mobile-spike/device-farm-test-spec.yml')

  console.log('Zipping and uploading flows as the test package...')
  const flowsZip = zipFlowsDir(FLOWS_DIR)
  const packageArn = await createAndWaitForUpload('maestro-flows.zip', 'APPIUM_NODE_TEST_PACKAGE', flowsZip)

  console.log('Scheduling run...')
  const { run } = await client.send(new ScheduleRunCommand({
    projectArn: DEVICE_FARM_PROJECT_ARN,
    appArn,
    devicePoolArn: DEVICE_FARM_DEVICE_POOL_ARN,
    name: `maestro-spike-${Date.now()}`,
    test: {
      type: 'APPIUM_NODE',
      testSpecArn: specArn,
      testPackageArn: packageArn,
    },
  }))

  console.log(`Run scheduled: ${run.arn}`)
  let current = run
  while (current.status !== 'COMPLETED') {
    await new Promise(r => setTimeout(r, 15000))
    const res = await client.send(new GetRunCommand({ arn: run.arn }))
    current = res.run
    console.log(`  status: ${current.status}`)
  }

  console.log(`Run finished: ${current.result} (${current.counters?.passed}/${current.counters?.total} passed)`)

  // Real parsing of Maestro's JUnit XML (from device-farm-test-spec.yml's
  // artifacts) into report-results.js's {total,passed,failed,results[]}
  // shape is the next step once a real run's artifact layout can be
  // inspected — ListArtifactsCommand below gets the file list; not yet
  // implemented since there's no real output to parse against yet.
  const artifacts = await client.send(new ListArtifactsCommand({ arn: current.arn, type: 'FILE' }))
  console.log('Artifacts:', artifacts.artifacts?.map(a => a.name))
}

main().catch(err => {
  console.error('Device Farm run failed:', err.message)
  process.exit(1)
})
