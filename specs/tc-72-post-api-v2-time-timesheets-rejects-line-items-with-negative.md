# TC-72: POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours

<!-- source: qa-tool test case 72 | type: api -->

## Scenario: TC-72 — POST /api/v2/time/timesheets rejects line items with negative or non-numeric hours

Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL.

Steps:
1. Authenticate via the app's session-cookie login flow: GET /web/index.php/auth/login for the CSRF token (the `token` prop rendered into the page's `auth-login` component), then POST /web/index.php/auth/validate as a form submission with fields `_token`, `username`, `password`. A successful login leaves the returned `_orangehrm` session cookie authorized for the API calls below (verified live: an authorized `_orangehrm` cookie returns `{"data":[],"meta":{"total":0},"rels":[]}` from GET /api/v2/time/timesheets, vs. `{"error":{"status":401,"message":"Session expired"}}` for an unauthorized one).
2. Create prerequisite time-tracking data, in order, reusing the same authenticated session:
   - POST /api/v2/time/customers with `{"name": <unique customer name>}` → 200, `{"data":{"id":<customerId>,"name":...,"description":"","deleted":false},"meta":[],"rels":[]}`
   - POST /api/v2/time/projects with `{"name": <unique project name>, "customerId": <customerId>}` (omit `description` — sending `"description":""` explicitly is rejected with 422 `invalidParamKeys:["description"]`; omit the key instead and the API defaults it to `null`) → 200, `{"data":{"id":<projectId>,"name":...,"description":null,"customer":{...},"deleted":false,"projectAdmins":[]},"meta":[],"rels":[]}`
   - POST /api/v2/time/project/{projectId}/activities (note: singular "project") with `{"name": <unique activity name>}` → 200, `{"data":{"id":<activityId>,"name":...,"deleted":false},"meta":[],"rels":[]}`
3. Create a timesheet container: POST /api/v2/time/timesheets with `{"date": <any date in the target week, e.g. today's date>}` → 200, `{"data":{"id":<timesheetId>,"status":{"id":"NOT SUBMITTED","name":"Not Submitted"},"startDate":<weekStart>,"endDate":<weekEnd>},"meta":[],"rels":[]}`
4. Attempt to record a negative-hours line item: PUT /api/v2/time/timesheets/{timesheetId}/entries with body
   ```json
   {
     "entries": [
       {
         "projectId": <projectId>,
         "activityId": <activityId>,
         "dates": { "<weekStart date, YYYY-MM-DD>": { "duration": "-3:00" } }
       }
     ]
   }
   ```
5. Record the HTTP status code and response body from the previous request.
6. Attempt to record a non-numeric-hours line item: PUT /api/v2/time/timesheets/{timesheetId}/entries with the same body shape as step 4, but `"duration": "abc"` instead of `"-3:00"`.
7. Record the HTTP status code and response body from the previous request.
8. GET /api/v2/time/timesheets/{timesheetId}/entries and confirm neither rejected attempt was persisted (the `data` array is still empty and every date in `meta.columns` still totals `00:00`).
9. For contrast, PUT /api/v2/time/timesheets/{timesheetId}/entries again with the same body shape but `"duration": "03:00"` (a valid value), to confirm the 422s above are specifically caused by the invalid duration values and not the request shape itself.

Expect:
- Both PUT calls in steps 4 and 6 (duration `"-3:00"` and duration `"abc"`) return **HTTP 422 Unprocessable Content** with body exactly `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["entries"]}}}` — verified live against the real API for both values.
- Neither call persists an entry: the follow-up GET in step 8 returns `"data":[]` and every date key under `meta.columns` still reports `{"total":{"hours":0,"minutes":0,"label":"00:00"}}` — verified live.
- The control PUT in step 9 (duration `"03:00"`) returns **HTTP 200** with a body whose `data` array contains one entry: `{"project":{"id":<projectId>,...},"customer":{...},"activity":{"id":<activityId>,...},"total":{"hours":3,"minutes":0,"label":"03:00"},"dates":{"<date>":{"id":<entryId>,"date":"<date>","comment":null,"duration":"03:00"}}}`, and `meta.sum` reports `{"hours":3,"minutes":0,"label":"03:00"}` — verified live, confirming the 422s in steps 4 and 6 are caused specifically by the invalid duration values, not by the request's overall shape.
