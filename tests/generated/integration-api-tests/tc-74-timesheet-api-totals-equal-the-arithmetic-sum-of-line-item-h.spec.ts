// spec: specs/tc-74-timesheet-api-totals-equal-the-arithmetic-sum-of-line-item-h.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'
import { createTimeTrackingSetup } from '../../../helpers/project-7/createTimeTrackingSetup'
import { createTimesheet } from '../../../helpers/project-7/createTimesheet'

// Formats `weekStart` (a "YYYY-MM-DD" Monday) + `offsetDays` as another "YYYY-MM-DD" date
// string, staying within the same week the timesheet was created for.
function dateOffset(weekStart: string, offsetDays: number): string {
  const base = new Date(`${weekStart}T00:00:00Z`)
  const target = new Date(base.getTime() + offsetDays * 24 * 60 * 60 * 1000)
  return target.toISOString().slice(0, 10)
}

test.describe('Timesheet API totals equal the arithmetic sum of line-item hours', () => {
  test('TC-74: Timesheet API totals equal the arithmetic sum of line-item hours', async ({
    request,
  }) => {
    // 1. Authenticate as an employee via the session-cookie login flow (proven helper: apiLogin)
    await test.step('Authenticate as an employee via the session-cookie login flow', async () => {
      await apiLogin(request)
    })

    // 2. Create prerequisite time-tracking data reusing the same authenticated session:
    // POST /api/v2/time/customers, then POST /api/v2/time/projects, then
    // POST /api/v2/time/project/{id}/activities (create at least two activities so the timesheet
    // can have multiple distinct line items)
    const { projectId, activityIds } = await test.step(
      'Create prerequisite time-tracking data (customer, project, two activities)',
      async () => createTimeTrackingSetup(request, { activityCount: 2 })
    )

    // 3. Send a POST request to /api/v2/time/timesheets with a date in a unique,
    // never-before-used past week to create the timesheet container
    const { timesheetId, weekStart } = await test.step(
      'Create the timesheet container for a unique past week',
      async () => createTimesheet(request)
    )

    const entriesUrl = `/web/index.php/api/v2/time/timesheets/${timesheetId}/entries`
    const day1 = dateOffset(weekStart, 0)
    const day2 = dateOffset(weekStart, 1)
    const day3 = dateOffset(weekStart, 2)
    const day4 = dateOffset(weekStart, 3)

    // 4. Send a PUT request to /api/v2/time/timesheets/{id}/entries with at least two line items
    // (distinct project/activity combinations), each with known, non-trivial duration values
    // across multiple dates (line item A: 03:00 on day 1 + 02:00 on day 2; line item B: 04:30 on
    // day 3 + 01:15 on day 4)
    await test.step('PUT two distinct line items with known durations across multiple dates', async () => {
      const res = await request.put(entriesUrl, {
        data: {
          entries: [
            {
              projectId,
              activityId: activityIds[0],
              dates: {
                [day1]: { duration: '03:00' },
                [day2]: { duration: '02:00' },
              },
            },
            {
              projectId,
              activityId: activityIds[1],
              dates: {
                [day3]: { duration: '04:30' },
                [day4]: { duration: '01:15' },
              },
            },
          ],
        },
      })
      expect(res.status()).toBe(200)
    })

    // 5. Send a GET request to /api/v2/time/timesheets/{id}/entries for the created timesheet
    const body = await test.step('GET the entries for the created timesheet', async () => {
      const res = await request.get(entriesUrl)
      expect(res.status()).toBe(200)
      return res.json()
    })

    // Body shape: { data: [...], meta: { sum: {...}, columns: {...}, timesheet: {...} }, rels: [] }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.rels).toEqual([])
    expect(body.meta.sum).toEqual(
      expect.objectContaining({
        hours: expect.any(Number),
        minutes: expect.any(Number),
        label: expect.any(String),
      })
    )

    expect(body.data).toHaveLength(2)
    const entryA = body.data.find((e: any) => e.activity.id === activityIds[0])
    const entryB = body.data.find((e: any) => e.activity.id === activityIds[1])
    expect(entryA).toBeTruthy()
    expect(entryB).toBeTruthy()

    // Each entry sums its own per-date durations: A = 03:00 + 02:00 = 05:00, B = 04:30 + 01:15 = 05:45
    expect(entryA.total).toEqual({ hours: 5, minutes: 0, label: '05:00' })
    expect(entryB.total).toEqual({ hours: 5, minutes: 45, label: '05:45' })

    // 6. Sum the `total` field (converted to total minutes: hours * 60 + minutes) of every line
    // item in the response's `data` array
    const computedSumMinutes = body.data.reduce(
      (acc: number, entry: any) => acc + entry.total.hours * 60 + entry.total.minutes,
      0
    )

    // 7. Compare the computed sum to the `meta.sum` field returned in the same response (also
    // converted to total minutes)
    const metaSumMinutes = body.meta.sum.hours * 60 + body.meta.sum.minutes
    expect(computedSumMinutes).toBe(metaSumMinutes)
    // Exact expected value per the plan's live-verified example: 05:00 + 05:45 = 10:45
    expect(metaSumMinutes).toBe(10 * 60 + 45)
    expect(body.meta.sum).toEqual({ hours: 10, minutes: 45, label: '10:45' })
  })
})
