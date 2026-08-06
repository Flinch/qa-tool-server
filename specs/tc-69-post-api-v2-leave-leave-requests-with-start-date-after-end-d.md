# TC-69: POST /api/v2/leave/leave-requests with start date after end date is rejected with a validation error

<!-- source: qa-tool test case 69 | type: api -->

## Scenario: TC-69 — POST /api/v2/leave/leave-requests with start date after end date is rejected with a validation error

Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL (http://localhost:8080/). The real endpoint path is `/web/index.php/api/v2/leave/leave-requests` (verified live — the bare `/api/v2/leave/leave-requests` path 404s at the Apache layer, i.e. it isn't routed at all). This endpoint requires an authenticated OrangeHRM session cookie; obtain it via `helpers/project-7/apiLogin.ts`'s `apiLogin(request)` before calling the endpoint — already a proven, working helper, not re-verified here.

The request body uses `leaveTypeId` (int), `fromDate`/`toDate` (`YYYY-MM-DD`), and `duration` (verified live: a valid submission is `{"leaveTypeId":1,"fromDate":"2026-08-10","toDate":"2026-08-20","duration":"full_day"}`, which returns `200` with `{"data":{"id":<id>,"leaveType":{"id":1,"name":"QA Annual Leave","deleted":false},"dateApplied":"<today>"},"meta":{"empNumber":<empNumber>},"rels":[]}`). A valid `leaveTypeId` can be obtained via `GET /web/index.php/api/v2/leave/leave-types`, which returns `{"data":[{"id":1,"name":"QA Annual Leave",...},{"id":2,"name":"QA Unpaid Leave",...}],"meta":{"total":2},"rels":[]}`.

Steps:
1. Call `apiLogin(request)` to establish an authenticated session (covered by the helper — not re-verified).
2. Send a POST request to `/web/index.php/api/v2/leave/leave-requests` with a `fromDate` that is later than `toDate` (e.g. `fromDate: "2026-08-25"`, `toDate: "2026-08-15"`), a valid `leaveTypeId`, and `duration: "full_day"`.
3. Record the HTTP status code and response body from the previous request.
4. Send a GET request to `/web/index.php/api/v2/leave/leave-requests?fromDate=<the same fromDate used in step 2>&toDate=<the same toDate used in step 2>` and confirm the response's `data` array does not contain any record matching the rejected date range (`meta.total` reflects no new record for that range).

Expect:
- The POST in step 2 returns **HTTP 422** with body exactly `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["fromDate","duration"]}}}` — verified live (both `fromDate` and `duration` are flagged together because the API derives the leave duration from the date range, and a `fromDate` after `toDate` makes that derived duration invalid too).
- No leave request record is persisted for the rejected attempt: the GET in step 4, filtered to the same `fromDate`/`toDate` range submitted in step 2, returns `200` with `"data":[]` (or, if other unrelated records happen to fall in that window, no entry whose `dates.fromDate`/`dates.toDate` match the rejected `fromDate`/`toDate` pair) — verified live: submitting `{"leaveTypeId":1,"fromDate":"2026-08-25","toDate":"2026-08-15","duration":"full_day"}` returned the 422 above, and a follow-up GET of `/web/index.php/api/v2/leave/leave-requests` showed only the unrelated, separately-created valid leave request (fromDate `2026-08-10`/toDate `2026-08-20`) — no record for the `2026-08-25`/`2026-08-15` pair exists.
