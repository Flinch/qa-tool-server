// spec: specs/tc-71-approving-or-rejecting-a-leave-request-yields-consistent-sta.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'
import { apiLoginAs } from '../../../helpers/project-7/apiLoginAs'
import type { APIRequestContext } from '@playwright/test'

// Same fallback the app's own playwright.config.js uses for `use.baseURL`.
const BASE_URL = process.env.TARGET_URL || 'https://service-desk-roan.vercel.app'

type Cycle = {
  action: 'APPROVE' | 'REJECT'
  fromDate: string
  toDate: string
  expectedStatusId: number
  expectedStatusName: string
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Picks a random future 2-day date range within the remaining days of the current calendar-year
// leave period (Jan 1 - Dec 31), at least `minDays` out, spread across nearly the whole remaining
// year instead of a narrow window — minimizes collision odds against any prior run's leave
// requests still on this shared, persistent instance (confirmed live: a narrow ~30-90 day window
// collided with a prior run's dates within a handful of re-runs).
function randomFutureRange(minDays: number): { from: Date; to: Date } {
  const now = new Date()
  const endOfYear = new Date(now.getFullYear(), 11, 31)
  const daysRemaining = Math.floor((endOfYear.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  const maxDays = Math.max(daysRemaining - 3, minDays + 1)
  const offsetDays = minDays + Math.floor(Math.random() * (maxDays - minDays))
  const from = new Date(now)
  from.setDate(from.getDate() + offsetDays)
  const to = new Date(from)
  to.setDate(from.getDate() + 1)
  return { from, to }
}

async function runApprovalCycle(
  approverRequest: APIRequestContext,
  employeeRequest: APIRequestContext,
  cycle: Cycle
) {
  let leaveId: number

  // 2. Using the employee context, log in as baselinemanager, then POST
  // /web/index.php/api/v2/leave/leave-requests with a valid leaveTypeId (1, "QA Annual Leave"),
  // a unique future fromDate/toDate range (2 consecutive days), and duration: "full_day". Record
  // the returned leave-request id from body.data.id.
  await test.step(
    `2. Log in as baselinemanager, then POST /web/index.php/api/v2/leave/leave-requests (${cycle.fromDate} to ${cycle.toDate}) and record the returned id`,
    async () => {
      await apiLoginAs(employeeRequest, 'baselinemanager', 'QaTool2026!Manager')

      const createResponse = await employeeRequest.post(
        '/web/index.php/api/v2/leave/leave-requests',
        {
          data: {
            leaveTypeId: 1,
            fromDate: cycle.fromDate,
            toDate: cycle.toDate,
            duration: 'full_day',
          },
        }
      )

      expect(createResponse.status()).toBe(200)
      const createBody = await createResponse.json()
      expect(createBody).toEqual({
        data: {
          id: expect.any(Number),
          leaveType: { id: 1, name: 'QA Annual Leave', deleted: false },
          dateApplied: cycle.fromDate,
        },
        meta: { empNumber: expect.any(Number) },
        rels: [],
      })
      leaveId = createBody.data.id
    }
  )

  // 3. Using the employee context, send GET /web/index.php/api/v2/leave/leave-requests (list
  // endpoint, implicitly scoped to the authenticated employee) and locate the record matching the
  // id from step 2 in body.data. Confirm its leaveBreakdown array contains exactly one entry with
  // name: "Pending Approval" (id: 1).
  await test.step(
    '3. GET /web/index.php/api/v2/leave/leave-requests and confirm the new record is Pending Approval',
    async () => {
      const listResponse = await employeeRequest.get('/web/index.php/api/v2/leave/leave-requests')
      expect(listResponse.status()).toBe(200)

      const listBody = await listResponse.json()
      const record = listBody.data.find((entry: any) => entry.id === leaveId)
      expect(record).toBeDefined()
      expect(record.leaveBreakdown).toEqual([
        { id: 1, name: 'Pending Approval', lengthDays: expect.any(Number) },
      ])
    }
  )

  // 4. Using the approver context, send PUT
  // /web/index.php/api/v2/leave/employees/leave-requests/{id} (the id from step 2) with JSON body
  // {"action": "APPROVE"} (or "REJECT" for the second cycle) to approve/reject the request.
  await test.step(
    `4. PUT /web/index.php/api/v2/leave/employees/leave-requests/{id} with {"action": "${cycle.action}"}`,
    async () => {
      const putResponse = await approverRequest.put(
        `/web/index.php/api/v2/leave/employees/leave-requests/${leaveId}`,
        { data: { action: cycle.action } }
      )

      expect(putResponse.status()).toBe(200)
      const putBody = await putResponse.json()
      // This action response itself carries no status field — the plan's own Expect line notes
      // this explicitly.
      expect(putBody).toEqual({
        data: {
          id: leaveId,
          leaveType: { id: 1, name: 'QA Annual Leave', deleted: false },
          dateApplied: cycle.fromDate,
        },
        meta: [],
        rels: [],
      })
    }
  )

  // 5. Using the employee context, repeat the GET /web/index.php/api/v2/leave/leave-requests list
  // request and locate the same record by id. Compare its leaveBreakdown status entry against
  // step 3's.
  await test.step(
    `5. Repeat GET /web/index.php/api/v2/leave/leave-requests and confirm leaveBreakdown now shows "${cycle.expectedStatusName}"`,
    async () => {
      // CLARIFICATION (approve path only, matches TC-64's confirmed finding): this self-hosted
      // OrangeHRM has no literal "Approved" status label — an approved, future-dated leave
      // request's real status name is "Scheduled" (id 2). The reject path's real status name,
      // "Rejected" (id -1), DOES match the plan's original wording exactly.
      const listResponse = await employeeRequest.get('/web/index.php/api/v2/leave/leave-requests')
      expect(listResponse.status()).toBe(200)

      const listBody = await listResponse.json()
      const record = listBody.data.find((entry: any) => entry.id === leaveId)
      expect(record).toBeDefined()
      expect(record.leaveBreakdown).toEqual([
        { id: cycle.expectedStatusId, name: cycle.expectedStatusName, lengthDays: expect.any(Number) },
      ])
    }
  )

  // 6. Using the employee context, send GET /web/index.php/api/v2/leave/leave-requests/{id}
  // (individual record endpoint, same id) for the same request.
  await test.step(
    '6. GET /web/index.php/api/v2/leave/leave-requests/{id} (individual record endpoint)',
    async () => {
      // POSSIBLE REGRESSION: the plan's original intent for this step was to cross-check the
      // record's status against the list endpoint's status for consistency (hence this test's own
      // title, "...consistent status across list and individual record endpoints"). Live-verified
      // (both for an approved/Scheduled record and a rejected/Rejected record) that this endpoint
      // NEVER exposes a status/leaveBreakdown field at all, in any state — its response is always
      // exactly {id, leaveType, dateApplied}. There is therefore no second view of status to
      // compare against the list endpoint through this endpoint; the cross-check the plan and this
      // test's title describe cannot be performed against the real API. Asserting the real,
      // status-less shape below instead of a false/weaker "consistency" assertion.
      const response = await employeeRequest.get(
        `/web/index.php/api/v2/leave/leave-requests/${leaveId}`
      )

      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body).toEqual({
        data: {
          id: leaveId,
          leaveType: { id: 1, name: 'QA Annual Leave', deleted: false },
          dateApplied: cycle.fromDate,
        },
        meta: [],
        rels: [],
      })
    }
  )
}

test.describe('TC-71 — Approving or rejecting a leave request yields consistent status across list and individual record endpoints', () => {
  // POSSIBLE REGRESSION: the plan's Expect line for step 6 (and this test's own title) call for
  // cross-checking a leave request's status between the list endpoint
  // (GET /api/v2/leave/leave-requests) and the individual-record endpoint
  // (GET /api/v2/leave/leave-requests/{id}) to confirm they agree. Live-verified against both an
  // approved (Scheduled) and a rejected record: the individual-record endpoint's response is
  // ALWAYS exactly {id, leaveType, dateApplied} — it never returns a status/leaveBreakdown field
  // in any state, so there is no second view of status to cross-check against the list endpoint
  // through it at all. No other single-record GET exposes status either (confirmed live that
  // GET /api/v2/leave/leaves/{id} returns 405, and
  // GET /api/v2/leave/employees/leave-requests/{id} returns the same status-less shape). This is
  // a genuine, permanent gap between the plan's assumed endpoint shape and the real API, not a
  // flaky or wording issue — the core "consistent status across ... endpoints" assertion this
  // test exists to make can never be satisfied against the real API as it stands today. Marked
  // fixme rather than silently weakening the assertion; steps 1-5 and 7's list-endpoint status
  // transitions (Pending Approval -> Scheduled/Rejected) DO pass, as confirmed live by
  // temporarily running this test's body without `.fixme()`.
  test.fixme(
    'TC-71: Approving or rejecting a leave request yields consistent status across list and individual record endpoints',
    async ({ request, playwright }) => {
      // 1. Using the approver context, call apiLogin(request) to establish an authenticated
      // session as qatooladmin.
      await test.step(
        '1. Using the approver context, call apiLogin(request) to establish an authenticated session as qatooladmin',
        async () => {
          await apiLogin(request)
        }
      )

      // Employee context: a genuinely separate APIRequestContext with its own cookie jar, so its
      // baselinemanager session never collides with the approver context's qatooladmin session —
      // OrangeHRM blocks a user from approving their own request, so these must stay distinct.
      // `storageState` is explicitly reset to empty here — confirmed live that
      // `playwright.request.newContext()` called from inside a test otherwise inherits the
      // current project's configured `storageState` (this project's `.auth/user.json`, the
      // qatooladmin session) by default, which would silently defeat the whole point of a
      // separate employee identity (a real run without this override logged the employee POST in
      // as empNumber 1 — the admin — instead of baselinemanager's empNumber).
      const employeeRequest = await playwright.request.newContext({
        baseURL: BASE_URL,
        storageState: { cookies: [], origins: [] },
      })

      try {
        const approveRange = randomFutureRange(5)
        const rejectRange = randomFutureRange(5)

        // 2-6. First cycle: submitted, then approved.
        await runApprovalCycle(request, employeeRequest, {
          action: 'APPROVE',
          fromDate: fmt(approveRange.from),
          toDate: fmt(approveRange.to),
          expectedStatusId: 2,
          expectedStatusName: 'Scheduled',
        })

        // 7. Repeat steps 2-6 for a second, separate leave request (different date range) that is
        // instead rejected in step 4 via PUT
        // /web/index.php/api/v2/leave/employees/leave-requests/{id} with {"action": "REJECT"}.
        await test.step(
          '7. Repeat steps 2-6 for a second, separate leave request that is instead rejected',
          async () => {
            await runApprovalCycle(request, employeeRequest, {
              action: 'REJECT',
              fromDate: fmt(rejectRange.from),
              toDate: fmt(rejectRange.to),
              expectedStatusId: -1,
              expectedStatusName: 'Rejected',
            })
          }
        )
      } finally {
        await employeeRequest.dispose()
      }
    }
  )
})
