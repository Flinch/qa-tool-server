# TC-40: Ticket cannot be saved without an assignee

<!-- source: qa-tool test case 40 | type: functional -->
<!-- automation rationale: Deterministic validation flow with a clear pass/fail assertion (required-field error) — good automation candidate. -->

<!-- BEHAVIOR MISMATCH: expected the ticket creation form to require an assignee and block submission with a validation error when it is left empty; actual behavior is the creation form (New Support Ticket modal) has no assignee field at all (fields are Title*, Description*, Category*, Priority, Attachment-optional), and submitting with Title/Description/Category filled succeeds unconditionally, creating the ticket with Assignee shown as "Unassigned" (confirmed live 2026-07-12, and corroborated by pre-existing seed tickets TKT-003 and TKT-005 which are already Unassigned). -->

## Scenario: TC-40 — Ticket cannot be saved without an assignee

Starting state: authenticated (storageState), on the dashboard.

Steps:
1. 1. Login as an admin user
2. 2. Navigate to the ticket creation form
3. 3. Fill in all required ticket fields except the assignee
4. 4. Click the Save or Submit button

Expect: The system displays a validation error indicating the assignee field is required and the ticket is not created
