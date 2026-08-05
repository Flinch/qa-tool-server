# TC-68: POST /api/v2/pim/employees with missing required fields is rejected with a validation error and no partial record is created

<!-- source: qa-tool test case 68 | type: api -->

## Scenario: TC-68 — POST /api/v2/pim/employees with missing required fields is rejected with a validation error and no partial record is created

Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL (http://localhost:8080/). The real endpoint path is `/web/index.php/api/v2/pim/employees` (verified live — the bare `/api/v2/pim/employees` path returns 404). This endpoint requires an authenticated OrangeHRM session cookie; obtain it via `helpers/project-7/apiLogin.ts`'s `apiLogin(request)` before calling the endpoint (same helper already proven out and used by TC-67 against this same endpoint).

Steps:
1. Call `apiLogin(request)` to establish an authenticated session.
2. Send a GET request to /web/index.php/api/v2/pim/employees and record the current `meta.total` employee count as the baseline.
3. Send a POST request to /web/index.php/api/v2/pim/employees with a JSON body omitting the required `firstName` field (e.g. `{ "lastName": "<unique>" }`).
4. Record the HTTP status code and response body.
5. Send a GET request to /web/index.php/api/v2/pim/employees and confirm `meta.total` is unchanged from the baseline recorded in step 2 — no partial record was created.
6. Send a POST request to /web/index.php/api/v2/pim/employees with a JSON body omitting the required `lastName` field (e.g. `{ "firstName": "<unique>" }`) and record the response.
7. Send a GET request to /web/index.php/api/v2/pim/employees and confirm `meta.total` is still unchanged from the baseline — no partial record was created.

Expect: Each request with a missing required field returns HTTP 422 (verified live 2026-08-05 — not 400; the endpoint never returns 400 for this case) with a body shaped `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["<field>"]}}}`, where `invalidParamKeys` names exactly the missing field (`["firstName"]` for the step-3 request — confirmed live with body `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["firstName"]}}}`; `["lastName"]` for the step-6 request — confirmed live with body `{"error":{"status":"422","message":"Invalid Parameter","data":{"invalidParamKeys":["lastName"]}}}`). Both follow-up GETs (steps 5 and 7) return HTTP 200 with `meta.total` and the employee list unchanged from the pre-test baseline (verified live: baseline was `{"data":[...2 employees...],"meta":{"total":2},"rels":[]}` both before and after the two rejected POSTs) — no partial employee record is persisted for either rejected request.
