# TC-37: Admin can assign a ticket to a user

<!-- source: qa-tool test case 37 | type: e2e -->
<!-- automation rationale: Deterministic CRUD flow (assign ticket to user) with a clear pass/fail assertion — good automation candidate. -->

## Scenario: TC-37 — Admin can assign a ticket to a user

Starting state: authenticated (storageState), on the dashboard.

Setup: Create a fresh ticket with `createTicket(page)` (helpers/createTicket.ts). The
creation modal has no assignee field, so every ticket it creates starts as Unassigned —
this gives the scenario an unassigned ticket to work with without mutating seed data.

Steps:
1. Login as an admin user (already satisfied by storageState — no login step in the generated test).
2. Navigate to the tickets list: click the "All Tickets" sidebar item. (It is a plain div with no role/testid, so `getByText('All Tickets')` is the correct locator — the text is static and unique.)
3. Open the newly created (unassigned) ticket by clicking its row in the tickets table (`getByRole('row', { name: <ticket title/ID> })`); this navigates to the ticket detail view.
4. In the Assignee panel (initially "No agent assigned"), click the "Assign" button, then select a user (e.g. "Bob Martinez (agent)") from the combobox that appears. It is the only combobox on the detail page, so `getByRole('combobox')` is safe without `.nth()`.
5. The assignment saves automatically on selection — there is no separate Save button. A "Ticket updated" toast appears immediately (assert on it before it auto-dismisses).

Expect: The ticket is saved with the selected user as the assignee and the change is reflected in the ticket details — the Assignee panel updates in place to show the selected user, and the assignment persists (after reload, the ticket's row in the All Tickets list shows the assignee in the Assignee column).
