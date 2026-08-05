// spec: specs/tc-67-post-api-v2-pim-employees-creates-a-record-that-is-immediate.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

// employeeId is capped at 10 characters server-side (verified live: an 11+ digit employeeId is
// rejected with a 422 `invalidParamKeys: ["employeeId"]`), so it needs its own generator distinct
// from the longer firstName/lastName suffix — a random 10-digit string keeps collision odds
// negligible without depending on run timing.
function uniqueEmployeeId(): string {
  return Math.floor(Math.random() * 1e10)
    .toString()
    .padStart(10, '0')
}

test.describe('POST /api/v2/pim/employees creates a record that is immediately retrievable via GET', () => {
  test('TC-67: POST /api/v2/pim/employees creates a record that is immediately retrievable via GET', async ({
    request,
  }) => {
    // 1. Call `apiLogin(request)` to establish an authenticated session.
    await test.step('Call apiLogin(request) to establish an authenticated session', async () => {
      await apiLogin(request)
    })

    const suffix = uniqueSuffix()
    const firstName = `QATest${suffix}`
    const lastName = `PlanCheck${suffix}`
    const employeeId = uniqueEmployeeId()

    // 2. Send a POST request to /web/index.php/api/v2/pim/employees with a unique firstName,
    // lastName, and employeeId (all required).
    // 3. Capture the new employee's empNumber from the response body's data.empNumber field.
    const empNumber = await test.step(
      'POST /web/index.php/api/v2/pim/employees with a unique firstName, lastName, and employeeId, then capture data.empNumber',
      async () => {
        const response = await request.post('/web/index.php/api/v2/pim/employees', {
          data: { firstName, lastName, employeeId },
        })

        // BEHAVIOR MISMATCH (documented in the plan, verified live 2026-08-05): a POST that
        // creates a resource would conventionally return 201, but this endpoint actually
        // returns 200 — asserting the real, confirmed behavior here, not the convention.
        expect(response.status()).toBe(200)

        const body = await response.json()
        expect(body.data.firstName).toBe(firstName)
        expect(body.data.lastName).toBe(lastName)
        expect(body.data.employeeId).toBe(employeeId)
        expect(body.data.empNumber).toBeDefined()

        return body.data.empNumber
      }
    )

    // 4. Immediately send a GET request to /web/index.php/api/v2/pim/employees/{empNumber} using
    // the captured empNumber.
    // 5. Compare the retrieved record's data.firstName, data.lastName, and data.employeeId fields
    // against the values submitted in the POST.
    await test.step(
      'GET /web/index.php/api/v2/pim/employees/{empNumber} and compare firstName, lastName, employeeId to the submitted values',
      async () => {
        const response = await request.get(`/web/index.php/api/v2/pim/employees/${empNumber}`)
        expect(response.status()).toBe(200)

        const body = await response.json()
        expect(body.data.empNumber).toBe(empNumber)
        expect(body.data.firstName).toBe(firstName)
        expect(body.data.lastName).toBe(lastName)
        expect(body.data.employeeId).toBe(employeeId)
      }
    )
  })
})
