# TC-74: Timesheet API totals equal the arithmetic sum of line-item hours

<!-- source: qa-tool test case 74 | type: api -->

## Scenario: TC-74 — Timesheet API totals equal the arithmetic sum of line-item hours

Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL (http://localhost:8080/). Authenticate via the session-cookie login flow (`helpers/project-7/apiLogin.ts`) — GET /web/index.php/auth/login for the CSRF token, then POST /web/index.php/auth/validate as a form submission; this is already a proven helper and does not need re-verification.

<!-- NOTE (planner refinement, verified live 2026-08-06): the original plan assumed GET
     /api/v2/time/timesheets/{id} returns a bare `total` field. Live curl verification shows
     that path returns 405 Method Not Allowed — there is no such endpoint. The real per-timesheet
     total lives under GET /api/v2/time/timesheets/{id}/entries, in the response's
     `meta.sum: { hours, minutes, label }`. Each individual line item in `data[]` also carries its
     own `total: { hours, minutes, label }` (the sum of that line item's per-date durations).
     Verified: creating two line items (project 1/activity 1: 03:00 + 02:00 => total 05:00;
     project 1/activity 2: 04:30 + 01:15 => total 05:45) produced `meta.sum = { hours: 10,
     minutes: 45, label: "10:45" }`, which exactly equals the arithmetic sum of the two line
     items' totals (05:00 + 05:45 = 10:45) — the endpoint and field names below have been
     corrected to match; the underlying business behavior (total = sum of line items) is real
     and holds. -->

Steps:
1. Authenticate as an employee via the session-cookie login flow (proven helper: `apiLogin`)
2. Create prerequisite time-tracking data reusing the same authenticated session: POST /api/v2/time/customers, then POST /api/v2/time/projects, then POST /api/v2/time/project/{id}/activities (create at least two activities so the timesheet can have multiple distinct line items)
3. Send a POST request to /api/v2/time/timesheets with a date in a unique, never-before-used past week to create the timesheet container
4. Send a PUT request to /api/v2/time/timesheets/{id}/entries with at least two line items (distinct project/activity combinations), each with known, non-trivial duration values across multiple dates (e.g. line item A: 03:00 on day 1 + 02:00 on day 2; line item B: 04:30 on day 3 + 01:15 on day 4)
5. Send a GET request to /api/v2/time/timesheets/{id}/entries for the created timesheet
6. Sum the `total` field (converted to total minutes: `hours * 60 + minutes`) of every line item in the response's `data` array
7. Compare the computed sum to the `meta.sum` field returned in the same response (also converted to total minutes)

Expect: GET /api/v2/time/timesheets/{id}/entries returns 200 with a body shaped `{ data: [...], meta: { sum: { hours, minutes, label }, columns: {...}, timesheet: {...}, ... }, rels: [] }`. Each entry in `data` has its own `total: { hours, minutes, label }` summing that line item's per-date durations. The top-level `meta.sum` field exactly equals the arithmetic sum (in minutes) of every line item's `total` field; there is no rounding discrepancy or omission. (There is no bare GET /api/v2/time/timesheets/{id} endpoint — that path returns 405 Method Not Allowed.)
