# TC-54: Submitting the New Ticket form with all required fields creates a ticket with Open status

## Application Overview

Service Desk app (https://service-desk-roan.vercel.app). Verified live against the running app: the sidebar nav item is 'All Tickets'; the button that opens the ticket creation modal is labeled 'New Ticket', and the resulting modal's heading text is 'New Support Ticket'; the modal's title field is labeled 'Title' (placeholder 'Brief summary of the issue') — not 'Summary' as originally worded; the Description field (placeholder 'Describe the issue in detail') and Category field labels match the original plan; the submit button is labeled 'Submit Ticket'. Live verification confirmed: submitting the form with Title/Description/Category filled in creates a new ticket that immediately appears in the All Tickets list with status 'Open'. No behavior mismatch found.

## Test Scenarios

### 1. Ticket Creation

**Seed:** `tests/seed.spec.ts`

#### 1.1. TC-54: Submitting the New Ticket form with all required fields creates a ticket with Open status

**File:** `tests/generated/ticket-creation/tc-54-submitting-the-new-ticket-form-with-all-required-fields-crea.spec.ts`

**Steps:**
  1. Starting state: authenticated via storageState, on the dashboard. (No UI login steps — auth is handled by the 'generated' project's storageState.)
  2. Click the 'New Ticket' button to open the ticket creation modal (modal heading reads 'New Support Ticket')
    - expect: The 'New Support Ticket' modal is displayed with Title, Description, Category, Priority, and Attachment fields
  3. Fill in the 'Title' field (placeholder 'Brief summary of the issue') with valid text
  4. Fill in the 'Description' field (placeholder 'Describe the issue in detail') with valid text
  5. Select a valid option in the 'Category' field
  6. Click the 'Submit Ticket' button
    - expect: A confirmation toast (e.g. 'Ticket <ID> created') is shown and the modal closes
  7. Click 'All Tickets' in the sidebar navigation to view the tickets list (note: the newly created ticket also appears immediately in the list if already on the All Tickets page, since the modal is opened from that page)
    - expect: A new ticket row is created and appears in the All Tickets list with a status of 'Open'
