// spec: specs/tc-69-post-api-v2-leave-leave-requests-with-start-date-after-end-d.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'

test.describe('POST /api/v2/leave/leave-requests with start date after end date is rejected with a validation error', () => {
  test('TC-69: POST /api/v2/leave/leave-requests with start date after end date is rejected with a validation error', async ({
    request,
  }) => {
    // 1. Call `apiLogin(request)` to establish an authenticated session.
    await test.step('Call apiLogin(request) to establish an authenticated session', async () => {
      await apiLogin(request)
    })

    const fromDate = '2026-08-25'
    const toDate = '2026-08-15'

    // 2. Send a POST request to /web/index.php/api/v2/leave/leave-requests with a fromDate that
    // is later than toDate, a valid leaveTypeId, and duration: "full_day".
    // 3. Record the HTTP status code and response body from the previous request.
    await test.step(
      'POST /web/index.php/api/v2/leave/leave-requests with fromDate after toDate and record status/body',
      async () => {
        const response = await request.post('/web/index.php/api/v2/leave/leave-requests', {
          data: {
            leaveTypeId: 1,
            fromDate,
            toDate,
            duration: 'full_day',
          },
        })

        expect(response.status()).toBe(422)

        const body = await response.json()
        expect(body).toEqual({
          error: {
            status: '422',
            message: 'Invalid Parameter',
            data: { invalidParamKeys: ['fromDate', 'duration'] },
          },
        })
      }
    )

    // 4. Send a GET request to /web/index.php/api/v2/leave/leave-requests?fromDate=<the same
    // fromDate used in step 2>&toDate=<the same toDate used in step 2> and confirm the response's
    // data array does not contain any record matching the rejected date range (meta.total
    // reflects no new record for that range).
    //
    // NOTE: live-verified that filtering this GET by the SAME fromDate/toDate query params used
    // in step 2 (fromDate after toDate) fails its own request-level validation and returns 422,
    // not 200 — the same date-order rule applies to the GET filter params, not just the POST
    // body. This is not the "no record was persisted" outcome under test, so it isn't asserted
    // here; instead we do an unfiltered GET (as the plan's Expect line's own live verification
    // narrative describes: "a follow-up GET of .../leave-requests showed only the unrelated...
    // record") and confirm no entry's dates match the rejected fromDate/toDate pair.
    await test.step(
      'GET /web/index.php/api/v2/leave/leave-requests and confirm no persisted record matches the rejected fromDate/toDate pair',
      async () => {
        const response = await request.get('/web/index.php/api/v2/leave/leave-requests')

        expect(response.status()).toBe(200)

        const body = await response.json()
        const matchingRecord = body.data.find(
          (record: any) => record.dates?.fromDate === fromDate && record.dates?.toDate === toDate
        )
        expect(matchingRecord).toBeUndefined()
      }
    )
  })
})
