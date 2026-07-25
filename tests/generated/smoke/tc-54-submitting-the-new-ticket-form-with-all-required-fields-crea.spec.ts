// spec: specs/tc-54-submitting-the-new-ticket-form-with-all-required-fields-crea.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTestData } from '../../../helpers/testData';

test.describe('Ticket Creation', () => {
  test('TC-54: Submitting the New Ticket form with all required fields creates a ticket with Open status', async ({ page }) => {
    const testData = createTestData();

    // 1. Starting state: authenticated via storageState, on the dashboard.
    await page.goto('/');

    // 2. Click the 'New Ticket' button to open the ticket creation modal.
    await page.getByRole('button', { name: 'New Ticket' }).first().click();

    // expect: The 'New Support Ticket' modal is displayed with Title, Description, Category, Priority, and Attachment fields.
    await expect(page.getByText('New Support Ticket')).toBeVisible();
    const titleField = page.getByRole('textbox', { name: 'Brief summary of the issue' });
    const descriptionField = page.getByRole('textbox', { name: 'Describe the issue in detail' });
    await expect(titleField).toBeVisible();
    await expect(descriptionField).toBeVisible();
    // FRAGILE: the Category/Priority/Attachment labels have no accessible
    // name or test id, and their bare text (e.g. "Priority") also appears
    // elsewhere on the page (table column header, sort dropdown option),
    // causing a strict-mode ambiguity if matched page-wide. Scoping to the
    // `.modal` container (a stable, hand-authored class, not auto-generated)
    // is the only reliable way to target them.
    const modal = page.locator('.modal');
    await expect(modal.getByText('Category *')).toBeVisible();
    await expect(modal.getByText('Priority')).toBeVisible();
    await expect(modal.getByText('Attachment (optional)')).toBeVisible();

    // 3. Fill in the 'Title' field (placeholder 'Brief summary of the issue') with valid unique text (use createTestData()).
    await titleField.fill(testData.title);

    // 4. Fill in the 'Description' field (placeholder 'Describe the issue in detail') with valid text.
    await descriptionField.fill(testData.description);

    // 5. Select a valid option in the 'Category' field.
    // FRAGILE: the Category/Priority selects also have no accessible name,
    // label association, or test id, so they can't be targeted via
    // getByRole(name) or getByLabel either. Scoping to `.modal` and taking
    // the first combobox (Category precedes Priority in the form) is the
    // only reliable option.
    await modal.getByRole('combobox').first().selectOption('Software');

    // 6. Click the 'Submit Ticket' button.
    await page.getByRole('button', { name: 'Submit Ticket' }).click();

    // expect: A confirmation toast (e.g. 'Ticket <ID> created') is shown and the modal closes.
    await expect(page.getByText(/Ticket .* created/)).toBeVisible();
    await expect(page.getByText('New Support Ticket')).not.toBeVisible();

    // 7. Click 'All Tickets' in the sidebar navigation to view the tickets list.
    await page.getByText('All Tickets').click();

    // expect: A new ticket row appears in the All Tickets list with status 'Open'.
    const newTicketRow = page.getByRole('row', { name: new RegExp(testData.title) });
    await expect(newTicketRow).toBeVisible();
    await expect(newTicketRow).toContainText('Open');
  });
});
