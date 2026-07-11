# TC-EXAMPLE: Submit a new support ticket

<!-- This is the plan format the qa-tool exporter (Phase 1) will emit from
     test_cases rows: one file per TC, numbered steps from steps JSONB,
     Expect lines from the expected column. The planner agent verifies these
     against the live app and amends wording; the generator turns them into
     tests/generated/<suite>/tc-<id>-*.spec.ts. -->

## Scenario: TC-EXAMPLE — user can submit a ticket and see it listed

Starting state: authenticated (storageState), on the dashboard.

Steps:
1. Click the "New Ticket" button
2. Fill "Brief summary of the issue" with a unique title
3. Fill "Describe the issue in detail" with a description
4. Select category "Software" and priority "High"
5. Fill the attachment description field
6. Click "Submit Ticket"

Expect: the new ticket appears in the ticket list with the unique title,
status "Open", and priority "High".
