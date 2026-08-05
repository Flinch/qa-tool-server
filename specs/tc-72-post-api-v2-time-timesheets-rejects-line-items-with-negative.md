# TC-72: POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours

<!-- source: qa-tool test case 72 | type: api -->
<!-- verified live against http://localhost:8080/ on 2026-08-05 -->

## Scenario: TC-72 — POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours

Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL (`http://localhost:8080/`).

Steps:
1. Authenticate via the app's session-cookie login flow:
   - GET `/web/index.php/auth/login`. The HTML response embeds the CSRF token as an escaped attribute on the `<auth-login>` element: `:token="&quot;<TOKEN>&quot;"`. Extract and HTML-unescape that value.
   - POST `/web/index.php/auth/validate` as `application/x-www-form-urlencoded` with fields `_token=<extracted token>`, `username=<test username>`, `password=<test password>`.
   - Expect: HTTP 302 redirect on success, and a `_orangehrm` session cookie set (path `/web`). Send this cookie on every subsequent request. (Verified live: a request to a protected endpoint without the cookie returns `{"error":{"status":401,"message":"Session expired"}}` with HTTP 401; with the cookie it succeeds.)
2. Create prerequisite time-tracking data, all under the `/web/index.php` prefix (the bare `/api/v2/...` path 404s — the app serves its API through the same front controller as the web UI):
   - POST `/web/index.php/api/v2/time/customers` with `{ "name": "<unique customer name>", "description": "<any text>" }` → Expect: HTTP 200, body `{"data":{"id":<number>,"name":...,"description":...,"deleted":false},"meta":[],"rels":[]}`. Capture `data.id` as `customerId`.
   - POST `/web/index.php/api/v2/time/projects` with `{ "customerId": <customerId>, "name": "<unique project name>", "description": "<any text>" }` (do NOT send `projectAdminEmployeeNumbers: []` — an empty array for that field is itself rejected with HTTP 422 `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["projectAdminEmployeeNumbers"]}}}`; omitting the field entirely is accepted) → Expect: HTTP 200, body `{"data":{"id":<number>,"name":...,"customer":{...},"deleted":false,"projectAdmins":[]},...}`. Capture `data.id` as `projectId`.
   - POST `/web/index.php/api/v2/time/project/{projectId}/activities` (note: singular "project") with `{ "name": "<unique activity name>" }` → Expect: HTTP 200, body `{"data":{"id":<number>,"name":...,"deleted":false},"meta":[],"rels":[]}`. Capture `data.id` as `activityId`.
3. Create a timesheet container: POST `/web/index.php/api/v2/time/timesheets` with `{ "date": "<any date in target week, YYYY-MM-DD>" }` → Expect: HTTP 200, body `{"data":{"id":<number>,"status":{"id":"NOT SUBMITTED","name":"Not Submitted"},"startDate":"<week start>","endDate":"<week end>"},"meta":[],"rels":[]}`. Capture `data.id` as `timesheetId`.
4. Attempt to record a negative-hours line item: PUT `/web/index.php/api/v2/time/timesheets/{timesheetId}/entries` with body:
   ```json
   {
     "entries": [
       {
         "projectId": "<projectId>",
         "activityId": "<activityId>",
         "dates": { "<date A, within the timesheet week>": { "duration": "-3:00" } }
       }
     ]
   }
   ```
   (This is the real payload shape used by the app's own frontend — confirmed by inspecting the served `app.js` bundle and by a live 200 response using it with a valid duration; a flatter `{projectId, activityId, entries: [{date, duration}]}` shape returns 422 with `invalidParamKeys` naming the top-level fields as unrecognized, not the duration value itself.)
5. Record the HTTP status code and response body from the previous request.
6. Attempt to record a non-numeric-hours line item: PUT `/web/index.php/api/v2/time/timesheets/{timesheetId}/entries` with the same shape, using a different date within the week (date B) and `"duration": "abc"`.
7. Record the HTTP status code and response body from the previous request.
8. GET `/web/index.php/api/v2/time/timesheets/{timesheetId}/entries` and confirm neither rejected attempt was persisted: the response's `data[].dates` map for the project/activity row must contain no key for date A or date B (or the row itself is absent if no valid entry was ever saved for it), and `meta.columns["<date A>"].total`/`meta.columns["<date B>"].total` both read `{"hours":0,"minutes":0,"label":"00:00"}`.
9. For contrast, PUT `/web/index.php/api/v2/time/timesheets/{timesheetId}/entries` with the same shape using a third date (date C) and a valid `"duration": "03:00"`, to confirm the endpoint and payload shape are otherwise correct and the earlier 422s were specifically caused by the invalid duration values.

Expect: Both PUT calls in steps 4 and 6 (duration `"-3:00"` and duration `"abc"`) return HTTP 422 Unprocessable Content with body exactly `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["entries"]}}}` — verified live for both values. Neither call persists an entry for its date (confirmed via the follow-up GET `.../entries` in step 8 — the date is absent from the row's `dates` map and its `meta.columns` total stays `00:00`). The contrast call in step 9 with a valid duration (`"03:00"`) returns HTTP 200 with a body containing `data[].dates["<date C>"]` = `{"id":<number>,"date":"<date C>","comment":null,"duration":"03:00"}`, confirming the 422s are specifically caused by the invalid duration values and not some other malformed part of the request.
