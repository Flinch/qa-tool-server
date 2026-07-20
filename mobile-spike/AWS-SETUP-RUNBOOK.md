# AWS Device Farm setup — closing out Phase 0 spike question #1

This is the one piece of the Phase 0 spike that needs your AWS account —
everything else (local Maestro flow authoring, the blind-vs-hierarchy-dump
comparison) is done and in `mobile-spike/FINDINGS.md`. This runbook gets
`scripts/device-farm-run.js` actually executing against a real device, to
answer: **does Device Farm's Custom Test Environment run Maestro cleanly
against a real binary, end to end?**

## 1. AWS account + Device Farm project

1. If you don't have an AWS account earmarked for this, create one (or use
   an existing org account with billing you're comfortable spiking against —
   Device Farm is pay-per-device-minute, see cost note below).
2. In the AWS Console, go to **Device Farm** → **Mobile Device Testing
   Projects** → **Create a new project**. Name it something like
   `qa-tool-mobile-spike`.
3. Copy the **project ARN** (looks like
   `arn:aws:devicefarm:us-west-2:123456789012:project:xxxxxxxx-xxxx-...`) —
   this goes in `.env` as `DEVICE_FARM_PROJECT_ARN`.

## 2. Device pool

1. Inside the project, go to **Device Pools** → **Create a new device pool**.
2. For the spike, pick a single real device (not the full public device
   fleet — cheaper, and this is just proving the pipeline works, not doing
   compatibility testing yet). Anything running Android 10+ is fine.
3. Copy the **device pool ARN** → `.env` as `DEVICE_FARM_DEVICE_POOL_ARN`.

## 3. IAM — scope credentials to Device Farm only

Don't reuse root or broad admin credentials. Create an IAM user (or role, if
you're running this from CI later) with a policy scoped to just Device Farm:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "devicefarm:CreateUpload",
      "devicefarm:GetUpload",
      "devicefarm:ScheduleRun",
      "devicefarm:GetRun",
      "devicefarm:ListArtifacts",
      "devicefarm:ListDevices",
      "devicefarm:ListDevicePools"
    ],
    "Resource": "*"
  }]
}
```

Generate an access key for this user → `.env` as `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`. Never commit `.env` — it's already gitignored, same
as the JIRA credentials.

## 4. A real app binary + install the SDK dependency

`device-farm-run.js` needs a real `.apk` to upload (`APP_BINARY_PATH` in
`.env` or exported before running). Any real Android app binary works for
proving the pipeline — doesn't need to be a client build, matching this
spike's local phase which deliberately used the stock Calculator app instead
of client-identifying data.

The script depends on `@aws-sdk/client-device-farm`, deliberately **not**
added to `package.json` by this spike (it'd be an unused dependency until
this actually gets wired in). Install it yourself before running:

```bash
npm install @aws-sdk/client-device-farm
```

## 5. Run it, and check the parts flagged as unverified

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=us-west-2
export DEVICE_FARM_PROJECT_ARN=... DEVICE_FARM_DEVICE_POOL_ARN=...
export APP_BINARY_PATH=/path/to/your.apk
node mobile-spike/scripts/device-farm-run.js
```

Two things in `device-farm-test-spec.yml` and `device-farm-run.js` are
written from AWS's documented Custom Test Environment format but **weren't
live-tested** (no AWS account existed during this spike) — double check these
against current AWS docs / actual run behavior the first time:

- The upload/test type strings (`APPIUM_NODE_TEST_SPEC`,
  `APPIUM_NODE_TEST_PACKAGE`, `APPIUM_NODE` as the nominal test type) — AWS's
  Custom Test Environment docs say any Appium framework works as the "host"
  type since the spec YAML overrides its default behavior, but exact enum
  casing should be confirmed against the SDK version actually installed.
- Whether Device Farm's host image really needs the `yum`/`apt` Java install
  fallback in `device-farm-test-spec.yml`'s `install` phase, or ships a JDK
  already — first real run's `install` phase log will show this immediately.
- The JUnit XML output path assumption (`$DEVICEFARM_LOG_DIR/maestro-
    results.xml`) — confirm this is where Device Farm actually surfaces it in
  `ListArtifactsCommand`'s results before building the real results parser
  (marked TODO in `device-farm-run.js` — needs one real run's artifact list
  to know the real shape to parse).

## 6. Cost

Device Farm is pay-as-you-go: **$0.17/device-minute**, or **$250/device-
slot/month** unmetered if usage is heavy enough to justify it. A single spike
run against one device for a few minutes costs cents. Don't set up the
unmetered tier until there's real usage data — track actual device-minutes
for a month first (per the handoff's original phased plan).

## When this is done

Once a real run completes, update `mobile-spike/FINDINGS.md`'s "AWS Device
Farm" section with what actually happened (pass/fail, any spec fixes needed,
real artifact paths) — that closes out Phase 0 spike question #1, and the
project's `DECISIONS.md` should get a follow-up entry.
