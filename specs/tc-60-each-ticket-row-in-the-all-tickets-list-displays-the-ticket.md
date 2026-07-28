# TC-60: Each ticket row in the All Tickets list displays the ticket's priority

<!-- source: qa-tool test case 60 | type: functional -->
<!-- automation rationale: Asserting a specific priority text in a list row is deterministic and scriptable with a clear pass/fail assertion. -->

## Scenario: TC-60 — Each ticket row in the All Tickets list displays the ticket's priority

Starting state: authenticated (storageState), on the dashboard.

<!-- NOTE (live-verified 2026-07-28): createTicket(page) sets Priority='High', so the created ticket's expected priority is 'High'. The "All Tickets" nav item is a plain div.nav-item (no link/button role, no testid) — reach it with getByText('All Tickets'). Ticket rows are a semantic <table>; each row exposes role 'row'. Priority renders as a color-coded <span class="badge"> (e.g. 'High') inside the row's Priority <td>, with no role/testid of its own — assert it as text within the row. -->

Steps:
1. Create a ticket with a known priority of 'High' via createTicket(page) — returns TestData with a unique .title
2. Navigate to the All Tickets list by clicking the 'All Tickets' nav item (page.getByText('All Tickets') — it is a div.nav-item, not a link/button role, so getByRole does not apply)
3. Locate the created ticket's row via page.getByRole('row', { name: TestData.title }) and inspect its priority

Expect: The created ticket's row displays the priority value set during creation — assert with expect(page.getByRole('row', { name: TestData.title })).toContainText('High')
