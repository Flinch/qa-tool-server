// spec: specs/tc-49-submitting-the-new-ticket-form-without-a-summary-field-does.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';

test.describe('New Ticket form validation', () => {
  test('TC-49: Submitting the New Ticket form without a Summary field does not create a ticket', async ({ page }) => {
    await page.goto('/');

    // Capture the ticket count before attempting submission, so we can assert
    // it is unchanged afterwards regardless of how many tickets currently exist.
    const ticketCountText = page.getByText(/^\d+ tickets$/);
    const initialCount = await ticketCountText.textContent();

    // 1. Open the 'New Ticket' form from the dashboard (click the 'New Ticket' button) —
    // the 'New Support Ticket' modal opens with 'Title *', 'Description *', 'Category *',
    // 'Priority', and 'Attachment (optional)' fields
    await test.step("Open the 'New Ticket' form from the dashboard", async () => {
      await page.getByRole('button', { name: 'New Ticket' }).first().click();

      await expect(page.getByText('New Support Ticket')).toBeVisible();
      await expect(page.getByText('Title *')).toBeVisible();
      await expect(page.getByText('Description *')).toBeVisible();
      await expect(page.getByText('Category *')).toBeVisible();
      // FRAGILE: getByText('Priority') is ambiguous (matches a table column header,
      // a <select> option, and this field's <label>), so the label is targeted via
      // its form-label class to disambiguate.
      await expect(page.locator('label.form-label').filter({ hasText: 'Priority' })).toBeVisible();
      await expect(page.getByText('Attachment (optional)')).toBeVisible();
    });

    // 2. Fill in the 'Description' field (placeholder 'Describe the issue in detail')
    // with valid text
    await test.step("Fill in the 'Description' field with valid text", async () => {
      const descriptionBox = page.getByRole('textbox', { name: 'Describe the issue in detail' });
      await descriptionBox.click();
      await descriptionBox.fill('TC-49 validation test description created by Playwright');
    });

    // 3. Select a valid option in the 'Category' combobox
    await test.step("Select a valid option in the 'Category' combobox", async () => {
      // The Category/Priority <select> elements in the New Ticket modal have no
      // accessible name (no <label for>, no wrapping, no aria-label), so
      // getByLabel/getByRole-with-name cannot target them directly. The modal
      // contains exactly two comboboxes (Category, then Priority), confirmed
      // via a live snapshot, so a positional lookup is the least-fragile option.
      // FRAGILE: positional combobox lookup on the New Ticket modal.
      await page.getByRole('combobox').nth(4).selectOption('Software');
    });

    // 4. Leave the 'Title' field (placeholder 'Brief summary of the issue' — the
    // "Summary" field in the manual test case) empty
    await test.step("Leave the 'Title' field empty", async () => {
      const titleBox = page.getByRole('textbox', { name: 'Brief summary of the issue' });
      await expect(titleBox).toHaveValue('');
    });

    // 5. Click the 'Submit Ticket' button
    await test.step("Click the 'Submit Ticket' button", async () => {
      await page.getByRole('button', { name: 'Submit Ticket' }).click();
    });

    // Expect: The form is not submitted (the modal stays open), an inline validation
    // error reading 'Title is required' is displayed under the Title field, and no
    // new ticket is created (the ticket count/list is unchanged)
    await test.step('Expect: form not submitted, inline validation error shown, no ticket created', async () => {
      await expect(page.getByText('New Support Ticket')).toBeVisible();
      await expect(page.getByText('Title is required')).toBeVisible();
      await expect(ticketCountText).toHaveText(initialCount ?? '');
    });
  });
});
