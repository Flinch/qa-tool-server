# TC-38: Admin can delete a ticket

<!-- source: qa-tool test case 38 | type: e2e -->
<!-- automation rationale: Deterministic CRUD flow with a clear pass/fail assertion (ticket removed from list) — good automation candidate. -->

## Scenario: TC-38 — Admin can delete a ticket

Starting state: authenticated (storageState) as an admin, on the dashboard/tickets list.

Steps:
1. Create a new ticket with a unique title (via the "New Ticket" button: fill "Brief summary of the issue", "Describe the issue in detail", select a Category and Priority, then click "Submit Ticket")
2. Locate the row for the newly created ticket in the tickets list, identified by its unique title
3. Click the "Delete ticket" button in that ticket's row
4. In the "Delete ticket?" confirmation dialog, click the "Delete" button to confirm

Expect: A "Ticket deleted" toast appears immediately after confirming, and the row for the created ticket's unique title no longer appears anywhere in the tickets list.
