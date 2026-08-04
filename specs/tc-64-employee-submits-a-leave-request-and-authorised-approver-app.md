# TC-64: Employee submits a leave request and authorised approver approves it with balance update

<!-- source: qa-tool test case 64 | type: e2e -->
<!-- automation rationale: The leave request and approval cycle — from application through balance deduction — is the core value of the Leave module and touches every critical leave requirement end-to-end. -->

<!-- BLOCKED (auth/role gap — flagging for reviewer, not inventing a workaround): this plan's
     original steps 1, 4, and 9 required three separate logins across two different identities
     (an "employee" and "the authorised approver (supervisor or HR admin)"), via explicit
     logout/login. Per AGENTS.md, generated tests run under the `generated` Playwright project
     starting ALREADY AUTHENTICATED via storageState, and must "NEVER write login steps inside
     a generated test" except when the test's subject IS authentication (which belongs in
     tests/smoke, not here). This project's `.generation-payload.json` and
     `tests/auth-setups/project-7.setup.ts` seed exactly ONE credential (qatooladmin / "QA
     Admin") — there is no second employee/approver account and no helpers/project-7/ helper
     for switching identities. The steps below drop the literal "log in as X" / "log out and
     log in as Y" language and keep the single already-authenticated user throughout — the same
     correction already applied to specs/tc-65-add-candidate-for-a-vacancy-and-progress-through-the-hiring.md
     for this project (see its planner note). This wording change ONLY makes the plan
     automatable if that one seeded account is itself both the leave applicant AND holds
     approval authority over its own request — the generator's single live walkthrough must
     confirm that. If the app instead enforces real separation of duty (the submitting account
     cannot see/act on its own request, or approval genuinely requires a different logged-in
     user), this scenario cannot be completed as a `generated`-project spec with the current
     single-credential seed data: mark it `test.fixme()` with a comment describing the identity
     gap instead of writing ad hoc login/logout steps, and this should be escalated for a
     second seeded approver credential/auth-setup rather than retried as-is. -->

<!-- planner note: no existing helper in helpers/project-7/ (or the flat helpers/) covers the
     Leave module (Apply / Leave List / Entitlements / My Leave). This plan is the first
     exploration of Leave for this project, the same situation tc-65 was in for Recruitment
     before createVacancy.ts/createCandidate.ts existed. If submitting and/or approving a leave
     request prove to be genuinely reusable setup actions while generating, extract them into
     new helpers/project-7/ file(s) per AGENTS.md's per-project helper convention. -->

## Scenario: TC-64 — Employee submits a leave request and authorised approver approves it with balance update

Starting state: authenticated (storageState), on the dashboard.

Steps:
1. Navigate to Leave > Apply
2. On the Apply Leave form, open the Leave Type selector and verify that leave types with a remaining balance of zero are not offered as selectable options — only leave types with a remaining positive balance are available for selection
3. Select a leave type with a positive balance, choose a date range, add a comment, and submit the leave request
4. Navigate to Leave > Leave List and filter by Pending Approval status. (Originally specified switching to a separate "authorised approver" login — see BLOCKED note above: this plan proceeds in the single already-authenticated session, with only one seeded credential available; the generator's live walkthrough must confirm this account can act as approver here, or fixme the test per the note above.)
5. Locate the submitted leave request by employee name in the Pending Approval list and verify it appears in the filtered results
6. Open the request and approve it
7. Verify the leave request status transitions to Approved
8. Navigate to Leave > My Leave and verify the same request shows Approved status. (Originally specified logging out and back in as the employee — same single-session caveat as step 4 above.)
9. Navigate to Leave > Entitlements or My Leave Balance and verify the remaining balance for that leave type has decreased by exactly the number of days taken in the approved request

Expect: The employee can only select leave types with an available (positive) balance when applying; the submitted request appears in the approver's Pending Approval filtered list; the approver successfully transitions the request to Approved status; and the employee's remaining leave balance for that leave type decreases by exactly the number of days taken in the approved request.
