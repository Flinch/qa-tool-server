// Creates a timesheet container via POST /api/v2/time/timesheets for a unique, never-before-used
// past week, reusing the session already established by apiLogin on the same `request` context.
// OrangeHRM rejects creating a second timesheet for a week that already has one (verified live: a
// leftover from an earlier run colliding with "today's date" was rejected) and rejects
// future-dated weeks outright, so every run needs its own past week, not just a unique name — the
// default week picker here draws from a wide range strictly before the current week to make that
// collision effectively impossible. Reuse this for any scenario needing a fresh timesheet to
// record entries against.
import type { APIRequestContext } from '@playwright/test'

function uniquePastMonday(): string {
  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7
  const thisMonday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday)
  )
  const weeksAgo = 100 + Math.floor(Math.random() * 100_000)
  const target = new Date(thisMonday.getTime() - weeksAgo * 7 * 24 * 60 * 60 * 1000)
  return target.toISOString().slice(0, 10)
}

export async function createTimesheet(
  request: APIRequestContext,
  overrides?: { weekStart?: string }
): Promise<{ timesheetId: number; weekStart: string }> {
  const weekStart = overrides?.weekStart ?? uniquePastMonday()

  const timesheetRes = await request.post('/web/index.php/api/v2/time/timesheets', {
    data: { date: weekStart },
  })
  if (timesheetRes.status() !== 200) {
    throw new Error(`createTimesheet: creation failed with status ${timesheetRes.status()}`)
  }
  const timesheet = (await timesheetRes.json()).data

  return { timesheetId: timesheet.id as number, weekStart }
}
