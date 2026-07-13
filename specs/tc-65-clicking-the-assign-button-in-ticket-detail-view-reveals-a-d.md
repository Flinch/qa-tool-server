# TC-65: Clicking the Assign button in ticket detail view reveals a dropdown of available agents

<!-- source: qa-tool test case 65 | type: functional -->
<!-- automation rationale: Triggering a UI element and asserting the visibility and content of a dropdown is deterministic and scriptable with a clear pass/fail assertion. -->

## Scenario: TC-65 — Clicking the Assign button in ticket detail view reveals a dropdown of available agents

Starting state: authenticated (storageState), on the dashboard.

Setup: Create a fresh ticket with `createTicket(page)` (helpers/createTicket.ts). The
creation modal has no assignee field, so every ticket it creates starts as Unassigned —
this is required because the "Assign" button only appears in the Assignee panel of an
UNASSIGNED ticket. (Verified live: an already-assigned ticket's Assignee panel shows the
assignee's name/avatar plus an unlabeled icon-only button instead — no "Assign" button —
so "any ticket" in the original plan wording was inaccurate and has been corrected here.)

Steps:
1. Login as an admin user (already satisfied by storageState — no login step in the generated test).
2. Navigate to the tickets list: click the "All Tickets" sidebar item, then open the newly created (unassigned) ticket by clicking its row (`getByRole('row', { name: <ticket title/ID> })`); this navigates to the ticket detail view.
3. In the Assignee panel (initially "No agent assigned"), click the "Assign" button (`getByRole('button', { name: 'Assign' })`).
4. Observe the UI response: inspect the options available in the combobox that replaced the Assign button. The "Assign" button is replaced in place by a native `<select>` element (accessible role `combobox`); it is the only combobox on the ticket detail page, so `getByRole('combobox')` is safe without `.nth()`.

Expect: A dropdown (native select/combobox) appears in place of the Assign button, populated with an "Unassigned" option (selected by default) plus one option per registered user — e.g. "Carol Kim (admin)", "Bob Martinez (agent)", "Ron Swanson (agent)" — confirming the dropdown is populated with at least one available agent. (Verified live against https://service-desk-roan.vercel.app on 2026-07-13: behavior matches this Expect, no BEHAVIOR MISMATCH.)
