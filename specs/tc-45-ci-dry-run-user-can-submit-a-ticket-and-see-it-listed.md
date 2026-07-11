# TC-45: CI dry-run: user can submit a ticket and see it listed

<!-- source: qa-tool test case 45 | type: functional -->
<!-- automation rationale: Simple UI flow, deterministic outcome, good automation candidate -->

## Scenario: TC-45 — CI dry-run: user can submit a ticket and see it listed

Starting state: authenticated (storageState), on the dashboard.

Steps:
1. Click the New Ticket button
2. Fill Brief summary of the issue with a unique title
3. Fill Describe the issue in detail with a description
4. Select category Software and priority High
5. Fill the attachment description field
6. Click Submit Ticket

Expect: The new ticket appears in the ticket list with the unique title, status Open, and priority High.
