# TC-72: POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours

<!-- source: qa-tool test case 72 | type: api -->

<!-- BEHAVIOR MISMATCH: expected the plan's employee-authenticated POST to reach the
     endpoint's payload validation (negative/non-numeric hours) and receive a 400/422
     validation error; actual live verification shows every /api/v2/time/* call —
     GET /api/v2/time/timesheets, GET /api/v2/time/timesheets/default,
     GET /api/v2/time/employees/{empNumber}/timesheets, GET /api/v2/time/customers, and
     POST /api/v2/time/timesheets itself — returns 403 Forbidden
     ({"error":{"status":403,"message":"Unauthorized"}}) for the only seeded credential
     available in this environment (qatooladmin / QaTool2026!Seed, an Admin-role account,
     confirmed via the login flow below). There is no separate ESS/employee-role account
     provisioned anywhere in the repo (checked helpers/project-7/, tests/auth-setups/,
     .github/scripts/fetch-*-payload.js) to authenticate as "an employee" with, and the
     Admin account itself is blocked from the entire Time module's API, not just this one
     route — so the scenario's precondition (reach the line-item validation at all) cannot
     be satisfied with what's available. This blocks verifying the negative/non-numeric
     hours behavior itself; it is a setup/access gap, not a confirmed validation bug, but
     it does contradict the plan's assumption that authenticating "as an employee" reaches
     a postable timesheet. Flagging and moving on per the behavior mismatch policy rather
     than retrying without a usable employee credential. -->

## Scenario: TC-72 — POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours

Starting state: no browser, no page, no storageState. Use the `request` fixture directly
against the configured baseURL (http://localhost:8080/). The real route lives at
`/web/index.php/api/v2/time/timesheets` (confirmed live: an anonymous request to this path
returns `401 {"error":{"status":401,"message":"Session expired"}}`, and the bare
`/api/v2/time/timesheets` path with no `/web/index.php` prefix 404s). Login is a two-step,
cookie-session flow, not a token endpoint: `GET /web/index.php/auth/login` to obtain a
session cookie and a CSRF-style `_token` embedded in the HTML (`auth-login :token="..."`
attribute), then `POST /web/index.php/auth/validate` with `_token`/`username`/`password`
form fields and the same cookie jar, confirmed live to redirect (302) to
`/web/index.php/dashboard/index` on success and reusing the cookie for subsequent requests.
No `helpers/project-7/` file covers this API login flow (its existing helpers are all
Playwright `page`-based UI flows) or timesheet setup, so this precondition needed live
verification; the only credential the project provides is `qatooladmin` / `QaTool2026!Seed`
(Admin role, from the generation payload / `tests/auth-setups/project-7.setup.ts`'s env-var
fallback) — no distinct "employee" login exists to satisfy the plan's "authenticate as an
employee" step.

Steps:
1. Authenticate as an employee (in this environment, only the seeded Admin credential
   `qatooladmin` / `QaTool2026!Seed` is available — see BEHAVIOR MISMATCH note above; a real
   employee/ESS-role credential should be provisioned for this scenario to be meaningfully
   testable)
2. Send a POST request to `/web/index.php/api/v2/time/timesheets` with a line item
   containing a negative hours value (e.g., -3)
3. Record the HTTP status code and response body
4. Send a POST request to the same endpoint with a line item containing a non-numeric hours
   value (e.g., 'abc')
5. Record the HTTP status code and response body

Expect: Both requests return HTTP 400 (or 422) with a clear validation error identifying the
invalid hours value; no timesheet record is created in either case.

<!-- NOT VERIFIED: live curl with the only available credential (qatooladmin) returns
     403 Forbidden on the POST itself (and on every GET variant of the timesheets
     endpoints tried: /api/v2/time/timesheets, /api/v2/time/timesheets/default,
     /api/v2/time/employees/{empNumber}/timesheets), before any payload validation runs —
     so the 400/422 validation behavior above could not be confirmed or refuted live. This
     needs either a provisioned ESS/employee-role test account or confirmation that Admin
     accounts are expected to manage employee timesheets through a different, working route
     before this plan can be fully verified. -->
