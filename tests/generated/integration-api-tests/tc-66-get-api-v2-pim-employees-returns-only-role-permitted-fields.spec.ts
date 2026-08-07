// spec: specs/tc-66-get-api-v2-pim-employees-returns-only-role-permitted-fields.md
import { test, expect } from '../../../helpers/apiTrace'
import { apiLogin } from '../../../helpers/project-7/apiLogin'
import { apiLoginAs } from '../../../helpers/project-7/apiLoginAs'
import type { APIResponse } from '@playwright/test'

// Same fallback the app's own playwright.config.js uses for `use.baseURL`.
const BASE_URL = process.env.TARGET_URL || 'https://service-desk-roan.vercel.app'

// Fields verified live to appear on every record this endpoint returns (default shape), for any
// role that can see records at all.
const BASE_EMPLOYEE_FIELDS = [
  'empNumber',
  'lastName',
  'firstName',
  'middleName',
  'employeeId',
  'terminationId',
].sort()

// Fields verified live to be added on top of the base shape when `model=detailed` is requested.
const DETAILED_EMPLOYEE_FIELDS = [...BASE_EMPLOYEE_FIELDS, 'jobTitle', 'subunit', 'empStatus', 'supervisors'].sort()

test.describe('GET /api/v2/pim/employees returns only role-permitted fields and excludes sensitive fields for unauthorised roles', () => {
  // POSSIBLE REGRESSION: this test case was originally scoped around field-level redaction — an
  // unauthorised role's response omitting salary/compensation fields that an authorised (admin)
  // role's response would include. Live-verified (2026-08-07) against
  // GET /web/index.php/api/v2/pim/employees (both default and `model=detailed` shapes, and also
  // GET /web/index.php/api/v2/pim/employees/{empNumber}): the admin role's response NEVER contains
  // a salary or compensation field either — the only fields ever present are empNumber, lastName,
  // firstName, middleName, employeeId, terminationId, and (with model=detailed) jobTitle, subunit,
  // empStatus, supervisors. That data isn't exposed by this resource at all for any role; it lives
  // under a different, unverified endpoint (e.g. the Job/Salary tab). Separately, the Supervisor
  // login used here (`baselinemanager`) does get a 200 from this same endpoint, but with
  // `data: []` (zero visible employee records for that account) rather than a field-filtered copy
  // of the admin's records. So there is no field-level redaction to observe on this endpoint —
  // only record-level (empty list) vs full-list access. Asserting the real, verified behavior
  // below instead of the originally-scoped (and non-existent) field-filtering behavior.
  test.fixme(
    'TC-66: GET /api/v2/pim/employees returns only role-permitted fields and excludes sensitive fields for unauthorised roles',
    async ({ request, playwright }) => {
      // 1. On a fresh APIRequestContext, authenticate as the seeded Supervisor/ESS-level login
      // baselinemanager / QaTool2026!Manager via apiLoginAs(request, 'baselinemanager', 'QaTool2026!Manager').
      await test.step(
        "1. On a fresh APIRequestContext, authenticate as baselinemanager via apiLoginAs(request, 'baselinemanager', 'QaTool2026!Manager')",
        async () => {
          await apiLoginAs(request, 'baselinemanager', 'QaTool2026!Manager')
        }
      )

      // 2. Send GET /web/index.php/api/v2/pim/employees?limit=5 using that session.
      let supervisorResponse: APIResponse
      await test.step(
        '2. Send GET /web/index.php/api/v2/pim/employees?limit=5 using that session',
        async () => {
          supervisorResponse = await request.get('/web/index.php/api/v2/pim/employees?limit=5')
        }
      )

      // 3. Inspect the response: verified live, this returns 200 with body
      // {"data": [], "meta": {"total": 0}, "rels": []} — no employee records at all are visible to
      // this account through this endpoint.
      await test.step(
        '3. Inspect the response: 200 with body {"data": [], "meta": {"total": 0}, "rels": []}',
        async () => {
          expect(supervisorResponse.status()).toBe(200)
          const supervisorBody = await supervisorResponse.json()
          expect(supervisorBody).toEqual({ data: [], meta: { total: 0 }, rels: [] })
        }
      )

      // 4. On a second, independent APIRequestContext, authenticate as qatooladmin /
      // QaTool2026!Seed via apiLogin(request) (env-default admin credentials).
      const adminRequest = await playwright.request.newContext({
        baseURL: BASE_URL,
        // Explicitly reset storageState — confirmed live (same finding as TC-71's spec) that
        // `playwright.request.newContext()` otherwise inherits this project's configured
        // storageState (the qatooladmin session already logged in via .auth/user.json), which
        // would silently defeat the point of using a genuinely separate identity here.
        storageState: { cookies: [], origins: [] },
      })

      try {
        await test.step(
          "4. On a second, independent APIRequestContext, authenticate as qatooladmin / QaTool2026!Seed via apiLogin(request)",
          async () => {
            await apiLogin(adminRequest)
          }
        )

        // 5. Send the same GET /web/index.php/api/v2/pim/employees?limit=5 request using the admin
        // session.
        let adminResponse: APIResponse
        await test.step(
          '5. Send the same GET /web/index.php/api/v2/pim/employees?limit=5 request using the admin session',
          async () => {
            adminResponse = await adminRequest.get('/web/index.php/api/v2/pim/employees?limit=5')
          }
        )

        // 6. Inspect the response: 200 with data containing both seeded employees, each shaped as
        // {empNumber, lastName, firstName, middleName, employeeId, terminationId} — no salary,
        // compensation, or any other field present. Re-request with &model=detailed and confirm it
        // adds only jobTitle, subunit, empStatus, supervisors — still no salary/compensation field.
        await test.step(
          '6. Inspect the response body shape, then re-request with &model=detailed and confirm the added fields — no salary/compensation field in either case',
          async () => {
            expect(adminResponse.status()).toBe(200)
            const adminBody = await adminResponse.json()
            expect(Array.isArray(adminBody.data)).toBe(true)
            expect(adminBody.data.length).toBeGreaterThan(0)

            for (const record of adminBody.data) {
              expect(Object.keys(record).sort()).toEqual(BASE_EMPLOYEE_FIELDS)
              expect(record).not.toHaveProperty('salary')
              expect(record).not.toHaveProperty('compensation')
            }

            const detailedResponse = await adminRequest.get(
              '/web/index.php/api/v2/pim/employees?limit=5&model=detailed'
            )
            expect(detailedResponse.status()).toBe(200)
            const detailedBody = await detailedResponse.json()
            expect(Array.isArray(detailedBody.data)).toBe(true)
            expect(detailedBody.data.length).toBeGreaterThan(0)

            for (const record of detailedBody.data) {
              expect(Object.keys(record).sort()).toEqual(DETAILED_EMPLOYEE_FIELDS)
              expect(record).not.toHaveProperty('salary')
              expect(record).not.toHaveProperty('compensation')
            }
          }
        )
      } finally {
        await adminRequest.dispose()
      }
    }
  )
})
