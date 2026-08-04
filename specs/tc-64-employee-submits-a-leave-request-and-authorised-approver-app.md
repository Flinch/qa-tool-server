# TC-64: Employee submits a leave request and authorised approver approves it with balance update

<!-- source: qa-tool test case 64 | type: e2e -->
<!-- automation rationale: The leave request and approval cycle — from application through balance deduction — is the core value of the Leave module and touches every critical leave requirement end-to-end. -->

<!-- planner note: this flow genuinely needs TWO distinct identities mid-test (employee applies,
     a DIFFERENT authorised approver approves — OrangeHRM blocks self-approval regardless of
     role), unlike TC-65's step 1 fix where "log in as X" was redundant because the plan's single
     actor already matched the storageState identity. The explicit log-in/log-out steps below are
     therefore NOT the disallowed "login steps inside a generated test" case from AGENTS.md (that
     rule assumes the test's one actor already matches the authenticated session) — they are the
     actual subject of this business flow (an approver acting on someone else's request) and
     should be kept, not stripped.

     docker/orangehrm-seed/README.md documents that this project's self-hosted seed was built
     specifically to unblock this test case, and gives the exact identities to use (no live
     verification needed to discover them — reuse, don't rediscover):
       - Employee: username `baselinemanager`, password `QaTool2026!Manager` (ESS role, tied to
         employee "Baseline Manager").
       - Approver: username `qatooladmin`, password `QaTool2026!Seed` (display name "QA Admin",
         Admin role) — this is also the default `TEST_USER_NAME`/`TEST_USER_PASSWORD` identity
         already used by the initial storageState (tests/auth-setups/project-7.setup.ts), and is
         seeded as `baselinemanager`'s direct supervisor, which is what makes the approval visible
         to it at all.
       - Seeded leave types: `QA Annual Leave` (has a 20-day entitlement for the current leave
         period, assigned to both seeded employees) and `QA Unpaid Leave` (no seeded entitlement).
         Use `QA Annual Leave` for the applied-for leave type below — it's the one guaranteed to
         have a positive balance.
     The README also records a real, already-verified end-to-end path for the approval step:
     `baselinemanager` applying shows up as "(1) Leave Request to Approve" in `qatooladmin`'s
     Dashboard "My Actions" widget, with Approve available from there — prefer that path over an
     unverified "Leave List filtered by Pending Approval" guess if the generator's live walkthrough
     finds My Actions faster/more direct; both are left as options below since exact navigation is
     the generator's live-walkthrough job, not the planner's. -->

<!-- planner note: no existing helper in helpers/project-7/ (or the flat helpers/) covers login-
     as-a-second-identity or any part of the Leave module — this is the first exploration of Leave
     for this project. If applying for leave and/or approving a leave request prove to be genuinely
     reusable actions while generating, extract them into new helpers/project-7/ file(s) per
     AGENTS.md's per-project helper convention (the same way createEmployee.ts/createVacancy.ts
     were extracted for PIM/Recruitment). -->

## Scenario: TC-64 — Employee submits a leave request and authorised approver approves it with balance update

Starting state: authenticated (storageState) as the seeded admin `qatooladmin` ("QA Admin"), on the dashboard.

Steps:
1. Log out of the default admin session and log in as the employee, the seeded ESS login `baselinemanager` / `QaTool2026!Manager` (see planner note above). Navigate to Leave > Apply.
2. On the Apply for Leave form's Leave Type dropdown, verify that only leave types with a remaining positive balance are available for selection — `QA Annual Leave` (seeded with a 20-day entitlement for this employee) should be selectable.
3. Select `QA Annual Leave`, choose a date range within the current leave period (calendar year, Jan 1 – Dec 31), add a comment, and submit the leave request.
4. Log out and log in as the authorised approver — the seeded admin login `qatooladmin` / `QaTool2026!Seed` ("QA Admin"), the seeded direct supervisor of `baselinemanager`.
5. Navigate to the approver's leave-approval view (the Dashboard "My Actions" widget, or Leave > Leave List filtered by Pending Approval status — see planner note above for the previously-verified path) and locate the request submitted by `baselinemanager`.
6. Verify the request appears in that view, identified by the employee's name.
7. Open the request and approve it.
8. Verify the leave request's status transitions to Approved.
9. Log out and log in again as the employee (`baselinemanager` / `QaTool2026!Manager`).
10. Navigate to Leave > My Leave and verify the request shows Approved status.
11. Navigate to the employee's own leave balance view (e.g. Leave > My Leave Balance, or Entitlements) and verify the remaining balance for `QA Annual Leave` has decreased by the exact number of days taken (starting entitlement was 20 days).

Expect: The employee (`baselinemanager`) can only select leave types with an available balance (`QA Annual Leave`, starting at a 20-day entitlement); the submitted request appears in the approver's (`qatooladmin`, the employee's supervisor) pending-approval view identified by employee name; the approver successfully transitions the request to Approved; the employee's My Leave view reflects the Approved status; and the employee's remaining `QA Annual Leave` balance decreases by exactly the number of days requested.
