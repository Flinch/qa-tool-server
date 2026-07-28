# TC-49: Submitting the New Ticket form without a Summary field does not create a ticket

<!-- source: qa-tool test case 49 | type: functional -->
<!-- automation rationale: Form validation on a required field is deterministic and scriptable with a clear pass/fail assertion based on error message presence and absence of a new ticket. -->

## Scenario: TC-49 — Submitting the New Ticket form without a Summary field does not create a ticket

Starting state: authenticated (storageState), on the dashboard.

<!-- NOTE (live-verified 2026-07-28): The manual test case calls the field "Summary", but the actual New Support Ticket modal labels it "Title *" (placeholder "Brief summary of the issue"). The observed validation error text is "Title is required". -->

Steps:
1. Open the 'New Ticket' form from the dashboard (click the 'New Ticket' button) — the 'New Support Ticket' modal opens with 'Title *', 'Description *', 'Category *', 'Priority', and 'Attachment (optional)' fields
2. Fill in the 'Description' field (placeholder 'Describe the issue in detail') with valid text
3. Select a valid option in the 'Category' combobox
4. Leave the 'Title' field (placeholder 'Brief summary of the issue' — the "Summary" field in the manual test case) empty
5. Click the 'Submit Ticket' button

Expect: The form is not submitted (the modal stays open), an inline validation error reading 'Title is required' is displayed under the Title field, and no new ticket is created (the ticket count/list is unchanged)
