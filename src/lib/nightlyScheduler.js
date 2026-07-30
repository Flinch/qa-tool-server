// Phase A, Part 6 — server-driven nightly suite runs, replacing GitHub
// Actions' own `schedule:` cron trigger (retired from playwright.yml and
// maestro-run.yml). Why this had to move: a scheduled GitHub Actions run
// has no correlation_id (it's not dispatched by this server at all), so its
// results webhook could never be routed to the right tenant via
// dispatch_index the way every other run already is — it could only fall
// back to trusting whatever project_id the payload claimed, which is
// exactly the trust gap this whole rework exists to close (see
// webhooks.js's resolveTenantId). Routing nightly runs through the same
// triggerSuiteRun() a manual "Run suite" click uses gives them a real
// correlation_id and closes that gap for good.
//
// No new dependency (node-cron etc.) — "once a day at a fixed UTC hour" is
// simple enough not to need one. setTimeout to the next occurrence, then
// re-arm every 24h from there.
import { listAllTenants } from '../db/tenantRegistry.js'
import { resolveTenantPool } from '../db/tenantPool.js'
import { triggerSuiteRun } from './automationTrigger.js'

const NIGHTLY_HOUR_UTC = 7 // matches the old GitHub Actions cron ('0 7 * * *')
const DAY_MS = 24 * 60 * 60 * 1000

async function runNightlySuites() {
  console.log('[nightlyScheduler] starting nightly sweep')
  const tenants = await listAllTenants()

  for (const tenant of tenants) {
    const db = await resolveTenantPool(tenant.id)
    if (!db) continue // not 'active' (provisioning/suspended) — skip, not an error

    let suites
    try {
      ;({ rows: suites } = await db.query(
        `SELECT id, name FROM automation_suites WHERE project_id=$1 AND nightly_enabled = true`,
        [tenant.id]
      ))
    } catch (e) {
      console.error(`[nightlyScheduler] tenant ${tenant.id} (${tenant.slug}): failed to list suites:`, e.message)
      continue
    }

    for (const suite of suites) {
      try {
        const run = await triggerSuiteRun({
          db, tenantId: tenant.id, projectId: tenant.id, suiteId: suite.id, userId: null, triggerType: 'nightly',
        })
        console.log(`[nightlyScheduler] tenant ${tenant.id} (${tenant.slug}): triggered "${suite.name}" -> run ${run.id}`)
      } catch (e) {
        // One suite/tenant failing to dispatch (e.g. no run workflow
        // configured for that platform) must not stop the sweep for
        // everyone else's nightly suites.
        console.error(`[nightlyScheduler] tenant ${tenant.id} (${tenant.slug}): failed to trigger suite ${suite.id} ("${suite.name}"):`, e.message)
      }
    }
  }
  console.log('[nightlyScheduler] sweep complete')
}

function msUntilNextRun() {
  const now = new Date()
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHTLY_HOUR_UTC, 0, 0, 0))
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

// Starts the recurring sweep — call once at server boot. Not exported as
// something route handlers invoke; this is background infrastructure, same
// spirit as the SSE broadcast setup.
export function startNightlyScheduler() {
  const scheduleNext = () => {
    const delay = msUntilNextRun()
    console.log(`[nightlyScheduler] next sweep in ${Math.round(delay / 60000)} min (${NIGHTLY_HOUR_UTC}:00 UTC)`)
    setTimeout(async () => {
      await runNightlySuites().catch(e => console.error('[nightlyScheduler] sweep threw:', e))
      setInterval(() => {
        runNightlySuites().catch(e => console.error('[nightlyScheduler] sweep threw:', e))
      }, DAY_MS)
    }, delay)
  }
  scheduleNext()
}
