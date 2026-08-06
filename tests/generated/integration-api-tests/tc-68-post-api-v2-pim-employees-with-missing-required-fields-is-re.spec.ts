// spec: specs/tc-68-post-api-v2-pim-employees-with-missing-required-fields-is-re.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'

// lastName/firstName are capped at 30 characters server-side (verified live: a 35-char value is
// rejected as an ADDITIONAL invalidParamKeys entry alongside the genuinely-missing field, which
// would corrupt this test's assertion on exactly which field is invalid), so the prefix here is
// kept short enough that prefix + suffix always stays comfortably under that limit.
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

test.describe('POST /api/v2/pim/employees with missing required fields is rejected with a validation error and no partial record is created', () => {
  test('TC-68: POST /api/v2/pim/employees with missing required fields is rejected with a validation error and no partial record is created', async ({
    request,
  }) => {
    // 1. Call `apiLogin(request)` to establish an authenticated session.
    await test.step('Call apiLogin(request) to establish an authenticated session', async () => {
      await apiLogin(request)
    })

    // 2. Send a GET request to /web/index.php/api/v2/pim/employees and record the current
    // meta.total employee count as the baseline.
    const baselineTotal = await test.step(
      'GET /web/index.php/api/v2/pim/employees and record the baseline meta.total',
      async () => {
        const response = await request.get('/web/index.php/api/v2/pim/employees')
        expect(response.status()).toBe(200)

        const body = await response.json()
        expect(body.meta.total).toBeDefined()
        return body.meta.total
      }
    )

    const suffix = uniqueSuffix()

    // 3. Send a POST request to /web/index.php/api/v2/pim/employees with a JSON body omitting
    // the required firstName field.
    // 4. Record the HTTP status code and response body.
    await test.step(
      'POST /web/index.php/api/v2/pim/employees with lastName only (firstName omitted) and record status/body',
      async () => {
        const response = await request.post('/web/index.php/api/v2/pim/employees', {
          data: { lastName: `QAMissF${suffix}` },
        })

        expect(response.status()).toBe(422)

        const body = await response.json()
        expect(body).toEqual({
          error: {
            status: '422',
            message: 'Invalid Parameter',
            data: { invalidParamKeys: ['firstName'] },
          },
        })
      }
    )

    // 5. Send a GET request to /web/index.php/api/v2/pim/employees and confirm meta.total is
    // unchanged from the baseline recorded in step 2 — no partial record was created.
    await test.step(
      'GET /web/index.php/api/v2/pim/employees and confirm meta.total is unchanged from the baseline',
      async () => {
        const response = await request.get('/web/index.php/api/v2/pim/employees')
        expect(response.status()).toBe(200)

        const body = await response.json()
        expect(body.meta.total).toBe(baselineTotal)
      }
    )

    // 6. Send a POST request to /web/index.php/api/v2/pim/employees with a JSON body omitting
    // the required lastName field and record the response.
    await test.step(
      'POST /web/index.php/api/v2/pim/employees with firstName only (lastName omitted) and record the response',
      async () => {
        const response = await request.post('/web/index.php/api/v2/pim/employees', {
          data: { firstName: `QAMissL${suffix}` },
        })

        expect(response.status()).toBe(422)

        const body = await response.json()
        expect(body).toEqual({
          error: {
            status: '422',
            message: 'Invalid Parameter',
            data: { invalidParamKeys: ['lastName'] },
          },
        })
      }
    )

    // 7. Send a GET request to /web/index.php/api/v2/pim/employees and confirm meta.total is
    // still unchanged from the baseline — no partial record was created.
    await test.step(
      'GET /web/index.php/api/v2/pim/employees and confirm meta.total is still unchanged from the baseline',
      async () => {
        const response = await request.get('/web/index.php/api/v2/pim/employees')
        expect(response.status()).toBe(200)

        const body = await response.json()
        expect(body.meta.total).toBe(baselineTotal)
      }
    )
  })
})
