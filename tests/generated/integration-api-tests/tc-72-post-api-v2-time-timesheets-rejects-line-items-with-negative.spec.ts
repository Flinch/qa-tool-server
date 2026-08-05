// spec: specs/tc-72-post-api-v2-time-timesheets-rejects-line-items-with-negative.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

// Picks a Monday from a wide, effectively-unique range of weeks strictly before the current
// week. Verified live: OrangeHRM rejects creating a timesheet for the CURRENT week when one
// already exists for that period (a leftover from an earlier run collided with "today's date"),
// and also rejects future-dated timesheets outright — so every run needs its own never-before-
// used past week, not just a unique name.
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

test.describe('POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours', () => {
  test('TC-72: POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours', async ({
    request,
  }) => {
    const suffix = uniqueSuffix()

    // 1. Authenticate via the app's session-cookie login flow: GET /web/index.php/auth/login for
    // the CSRF token, then POST /web/index.php/auth/validate as a form submission.
    await test.step("Authenticate via the app's session-cookie login flow", async () => {
      await apiLogin(request)
    })

    // 2. Create prerequisite time-tracking data, in order, reusing the same authenticated
    // session: POST .../customers, then POST .../projects, then POST .../project/{id}/activities
    const { projectId, activityId } = await test.step(
      'Create prerequisite time-tracking data (customer, project, activity)',
      async () => {
        const customerRes = await request.post('/web/index.php/api/v2/time/customers', {
          data: { name: `TC72 Customer ${suffix}` },
        })
        expect(customerRes.status()).toBe(200)
        const customer = (await customerRes.json()).data
        expect(customer.deleted).toBe(false)

        // Omit `description` on the project POST — sending `""` explicitly is rejected 422.
        const projectRes = await request.post('/web/index.php/api/v2/time/projects', {
          data: { name: `TC72 Project ${suffix}`, customerId: customer.id },
        })
        expect(projectRes.status()).toBe(200)
        const project = (await projectRes.json()).data
        expect(project.description).toBeNull()
        expect(project.customer.id).toBe(customer.id)

        const activityRes = await request.post(
          `/web/index.php/api/v2/time/project/${project.id}/activities`,
          { data: { name: `TC72 Activity ${suffix}` } }
        )
        expect(activityRes.status()).toBe(200)
        const activity = (await activityRes.json()).data
        expect(activity.deleted).toBe(false)

        return { projectId: project.id as number, activityId: activity.id as number }
      }
    )

    // 3. Create a timesheet container: POST /api/v2/time/timesheets with a date in the target week
    const weekStart = uniquePastMonday()
    const timesheetId = await test.step('Create a timesheet container', async () => {
      const timesheetRes = await request.post('/web/index.php/api/v2/time/timesheets', {
        data: { date: weekStart },
      })
      expect(timesheetRes.status()).toBe(200)
      const timesheet = (await timesheetRes.json()).data
      expect(timesheet.status).toEqual({ id: 'NOT SUBMITTED', name: 'Not Submitted' })
      expect(timesheet.startDate).toBe(weekStart)
      return timesheet.id as number
    })

    const entriesUrl = `/web/index.php/api/v2/time/timesheets/${timesheetId}/entries`
    const entryBody = (duration: string) => ({
      entries: [
        {
          projectId,
          activityId,
          dates: { [weekStart]: { duration } },
        },
      ],
    })
    const EXPECTED_422_BODY = {
      error: {
        status: '422',
        message: 'Invalid Parameter',
        data: { invalidParamKeys: ['entries'] },
      },
    }

    // 4. Attempt to record a negative-hours line item: PUT .../entries with duration "-3:00"
    // 5. Record the HTTP status code and response body from the previous request
    await test.step(
      'Attempt to record a negative-hours line item (duration "-3:00") and record the response',
      async () => {
        const res = await request.put(entriesUrl, { data: entryBody('-3:00') })
        expect(res.status()).toBe(422)
        expect(await res.json()).toEqual(EXPECTED_422_BODY)
      }
    )

    // 6. Attempt to record a non-numeric-hours line item: PUT .../entries with duration "abc"
    // 7. Record the HTTP status code and response body from the previous request
    await test.step(
      'Attempt to record a non-numeric-hours line item (duration "abc") and record the response',
      async () => {
        const res = await request.put(entriesUrl, { data: entryBody('abc') })
        expect(res.status()).toBe(422)
        expect(await res.json()).toEqual(EXPECTED_422_BODY)
      }
    )

    // 8. GET .../entries and confirm neither rejected attempt was persisted
    await test.step(
      'GET the entries and confirm neither rejected attempt was persisted',
      async () => {
        const res = await request.get(entriesUrl)
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.data).toEqual([])
        const columnDates = Object.keys(body.meta.columns)
        expect(columnDates.length).toBeGreaterThan(0)
        for (const dateKey of columnDates) {
          expect(body.meta.columns[dateKey].total).toEqual({ hours: 0, minutes: 0, label: '00:00' })
        }
      }
    )

    // 9. For contrast, PUT again with the same shape but a valid duration ("03:00")
    await test.step(
      'PUT again with a valid duration ("03:00") to confirm the 422s were caused by the invalid values, not the request shape',
      async () => {
        const res = await request.put(entriesUrl, { data: entryBody('03:00') })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.data).toHaveLength(1)
        const entry = body.data[0]
        expect(entry.project.id).toBe(projectId)
        expect(entry.activity.id).toBe(activityId)
        expect(entry.total).toEqual({ hours: 3, minutes: 0, label: '03:00' })
        expect(entry.dates[weekStart].duration).toBe('03:00')
        expect(body.meta.sum).toEqual({ hours: 3, minutes: 0, label: '03:00' })
      }
    )
  })
})
