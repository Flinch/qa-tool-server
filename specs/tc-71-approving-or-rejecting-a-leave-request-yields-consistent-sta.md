# TC-71: Approving or rejecting a leave request yields consistent status across list and individual record endpoints

<!-- source: qa-tool test case 71 | type: api -->

## Scenario: TC-71 — Approving or rejecting a leave request yields consistent status across list and individual record endpoints

Starting state: no browser, no page, no storageState. Use Playwright's `request`
fixture directly against the configured baseURL (`http://localhost:8080/`).
Two distinct authenticated identities are needed (an employee who submits leave,
and that employee's supervisor who approves/rejects it — OrangeHRM blocks a user
from approving their own request, same reason `helpers/project-7/loginAs.ts`
documents for the UI pipeline), so use two separate `APIRequestContext`s, each
with its own cookie jar:
- Approver context: `apiLogin(request)` from `helpers/project-7/apiLogin.ts`
  (defaults to the seeded admin login `qatooladmin` / `QaTool2026!Seed` via
  `TEST_USER_NAME`/`TEST_USER_PASSWORD`), which is the seeded direct supervisor
  of the employee below.
- Employee context: the same CSRF-scrape (GET `/web/index.php/auth/login`,
  regex out the `:token="&quot;...&quot;"` prop) + form-post
  (POST `/web/index.php/auth/validate` with `_token`/`username`/`password`)
  dance `apiLogin` itself uses, but for the seeded ESS login
  `baselinemanager` / `QaTool2026!Manager` — `apiLogin` itself only supports
  the admin credentials from env, so this second identity is logged in
  inline (or via a small local adaptation), not through `apiLogin` directly.

Steps:
1. Using the approver context, call `apiLogin(request)` to establish an
   authenticated session as `qatooladmin`.
2. Using the employee context, log in as `baselinemanager` (CSRF-scrape +
   form-post, as described above), then send `POST
   /web/index.php/api/v2/leave/leave-requests` with a valid `leaveTypeId`
   (`1`, "QA Annual Leave"), a unique future `fromDate`/`toDate` range (2
   consecutive days, to avoid colliding with a prior run's request), and
   `duration: "full_day"`. Record the returned leave-request `id` from
   `body.data.id`.
3. Using the employee context, send `GET /web/index.php/api/v2/leave/leave-requests`
   (list endpoint, implicitly scoped to the authenticated employee — this
   endpoint has no `employee`/`empNumber`/`includeEmployees` filter params at
   all; passing any of those returns 422 with `invalidParamKeys` naming the
   param) and locate the record matching the `id` from step 2 in `body.data`.
   Confirm its `leaveBreakdown` array contains exactly one entry with
   `name: "Pending Approval"` (`id: 1`).
4. Using the approver context, send `PUT
   /web/index.php/api/v2/leave/employees/leave-requests/{id}` (the `id` from
   step 2) with JSON body `{"action": "APPROVE"}` to approve the request.
5. Using the employee context, repeat the `GET
   /web/index.php/api/v2/leave/leave-requests` list request and locate the
   same record by `id`. Compare its `leaveBreakdown` status entry against
   step 3's.
6. Using the employee context, send `GET
   /web/index.php/api/v2/leave/leave-requests/{id}` (individual record
   endpoint, same `id`) for the same request.
7. Repeat steps 2–6 for a second, separate leave request (different date
   range) that is instead rejected in step 4 via `PUT
   /web/index.php/api/v2/leave/employees/leave-requests/{id}` with JSON body
   `{"action": "REJECT"}`.

Expect:
- Step 2's POST returns `200` with body
  `{"data": {"id": <number>, "leaveType": {"id": 1, "name": "QA Annual Leave", "deleted": false}, "dateApplied": "<date>"}, "meta": {"empNumber": <employee's empNumber>}, "rels": []}`.
- Step 3's GET returns `200`; the matching record's `leaveBreakdown` is
  `[{"id": 1, "name": "Pending Approval", "lengthDays": <n>}]`.
- Step 4's PUT (approve) returns `200` with body
  `{"data": {"id": <number>, "leaveType": {...}, "dateApplied": "<date>"}, "meta": [], "rels": []}`
  — this action response itself carries no status field.
- Step 5's GET (post-approval list): the same record's `leaveBreakdown`
  becomes `[{"id": 2, "name": "Scheduled", "lengthDays": <n>}]`.
  <!-- CLARIFICATION (not a mismatch, matches TC-64's confirmed finding):
  this self-hosted OrangeHRM has no literal "Approved" status label — an
  approved, future-dated leave request's real status name is "Scheduled"
  (a past/current one becomes "Taken" instead). Functionally this IS the
  approval outcome, just under the app's own real terminology, not the
  literal string 'Approved' the original plan assumed. -->
- Step 6's GET (individual record endpoint) returns `200` with body
  `{"data": {"id": <number>, "leaveType": {...}, "dateApplied": "<date>"}, "meta": [], "rels": []}`
  — identical shape regardless of the record's actual approval/rejection
  state.
  <!-- BEHAVIOR MISMATCH: expected the individual record endpoint (GET
  /api/v2/leave/leave-requests/{id}) to expose a status field so it could be
  compared against the list endpoint's status for consistency, as the
  original plan's Expect line assumed ("the status is 'Approved'/'Rejected'
  in both the list and individual endpoints"). Live-verified against both an
  approved (id 3, leaveBreakdown -> Scheduled) and a rejected (id 4,
  leaveBreakdown -> Rejected) request: this endpoint's response is always
  exactly {id, leaveType, dateApplied} in every state — it never returns any
  status/leaveBreakdown field at all, so there is no second view of status
  to cross-check against the list endpoint through this endpoint. No other
  GET endpoint exposes a single leave-request's status either — confirmed
  live that GET /api/v2/leave/leaves/{id} and GET
  /api/v2/leave/employees/leave-requests/{id} return 405 and the same
  status-less {id, leaveType, dateApplied} shape respectively. Status only
  ever appears in the list endpoints' (`/api/v2/leave/leave-requests` and
  `/api/v2/leave/employees/leave-requests`) `leaveBreakdown` array. This is
  a genuine gap between the plan's assumed endpoint shape and the real API,
  not a wording issue — flagged here rather than forced into a false
  assertion. -->
- Step 7 (rejection path): step 4's PUT with `{"action": "REJECT"}` returns
  `200` with the same status-less action-response shape; the repeated step
  5 GET shows the record's `leaveBreakdown` become
  `[{"id": -1, "name": "Rejected", "lengthDays": <n>}]` — this vocabulary
  DOES match the plan's original "Rejected" expectation exactly (unlike the
  approve case above). Step 6's individual-record GET for this second
  record returns the same status-less shape as the approved one, for the
  same reason noted in the BEHAVIOR MISMATCH comment above.
