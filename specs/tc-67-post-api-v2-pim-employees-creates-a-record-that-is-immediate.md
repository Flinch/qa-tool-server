# TC-67: POST /api/v2/pim/employees creates a record that is immediately retrievable via GET

<!-- source: qa-tool test case 67 | type: api -->

## Scenario: TC-67 — POST /api/v2/pim/employees creates a record that is immediately retrievable via GET

Starting state: no browser, no page, no storageState. Use the `request` fixture directly against the configured baseURL (http://localhost:8080/). The real endpoint path is `/web/index.php/api/v2/pim/employees` (verified live — the bare `/api/v2/pim/employees` path returns 404). This endpoint requires an authenticated OrangeHRM session cookie; obtain it via `helpers/project-7/apiLogin.ts`'s `apiLogin(request)` before calling the endpoint (verified live: an unauthenticated call returns 401).

Steps:
1. Call `apiLogin(request)` to establish an authenticated session.
2. Send a POST request to /web/index.php/api/v2/pim/employees with a unique `firstName`, `lastName`, and `employeeId` (all required).
3. Capture the new employee's `empNumber` from the response body's `data.empNumber` field.
4. Immediately send a GET request to /web/index.php/api/v2/pim/employees/{empNumber} using the captured `empNumber`.
5. Compare the retrieved record's `data.firstName`, `data.lastName`, and `data.employeeId` fields against the values submitted in the POST.

<!-- BEHAVIOR MISMATCH: expected POST to return HTTP 201, actual is HTTP 200. Verified live 2026-08-05: POST /web/index.php/api/v2/pim/employees with {"firstName":"QATest5555","lastName":"PlanCheck1111","employeeId":"9977"} returned `200 OK` with body `{"data":{"empNumber":8,"lastName":"PlanCheck1111","firstName":"QATest5555","middleName":"","employeeId":"9977","terminationId":null},"meta":[],"rels":[]}` — not 201. -->

Expect: The POST returns HTTP 200 (not 201 — see BEHAVIOR MISMATCH above) with the created employee data nested under `data` (`data.empNumber`, `data.firstName`, `data.lastName`, `data.employeeId`, `data.middleName`, `data.terminationId`); the subsequent GET to /web/index.php/api/v2/pim/employees/{empNumber} returns HTTP 200 with a `data` object whose `firstName`, `lastName`, and `employeeId` fields exactly match the submitted values (verified live: GET /web/index.php/api/v2/pim/employees/8 returned `200` with `{"data":{"empNumber":8,"lastName":"PlanCheck1111","firstName":"QATest5555","middleName":"","employeeId":"9977","terminationId":null},"meta":[],"rels":[]}`, matching the POST above).
