// spec: specs/tc-40-ticket-cannot-be-saved-without-an-assignee.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTestData } from '../../../helpers/testData';

test.describe('Ticket cannot be saved without an assignee', () => {
  // POSSIBLE REGRESSION: The plan expects the ticket creation form to require
  // an assignee and block submission with a validation error when it is left
  // empty. Confirmed live (2026-07-12): the "New Support Ticket" modal has NO
  // assignee field at all (fields are only Title*, Description*, Category*,
  // Priority, and Attachment [optional]). Submitting with Title/Description/
  // Category filled succeeds unconditionally, creating the ticket with
  // Assignee shown as "Unassigned" — consistent with pre-existing seed
  // tickets TKT-003 and TKT-005, which are already Unassigned. No validation
  // error is ever shown. Marking fixme and documenting the intended (per-plan)
  // assertions below for the reviewer.
  test.fixme('TC-40: Ticket cannot be saved without an assignee', async ({ page }) => {
    const data = createTestData();

    await page.goto('/');

    // 1. Login as an admin user
    // Already satisfied by storageState — no login step in the generated test.

    // 2. Navigate to the ticket creation form
    await test.step('Navigate to the ticket creation form', async () => {
      await page.getByRole('button', { name: 'New Ticket' }).first().click();
    });

    // 3. Fill in all required ticket fields except the assignee
    await test.step('Fill in all required ticket fields except the assignee', async () => {
      const titleBox = page.getByRole('textbox', { name: 'Brief summary of the issue' });
      await titleBox.click();
      await titleBox.fill(data.title);

      const descriptionBox = page.getByRole('textbox', { name: 'Describe the issue in detail' });
      await descriptionBox.click();
      await descriptionBox.fill(data.description);

      // The Category/Priority <select> elements in the New Ticket modal have no
      // accessible name (no <label for>, no wrapping, no aria-label), so
      // getByLabel/getByRole-with-name cannot target them directly. The modal
      // contains exactly two comboboxes (Category, then Priority), confirmed
      // via a live snapshot, so a positional lookup is the least-fragile option.
      // FRAGILE: positional combobox lookup on the New Ticket modal.
      // (There is no assignee field/combobox anywhere in this modal.)
      await page.getByRole('combobox').nth(4).selectOption('Software');
      await page.getByRole('combobox').nth(5).selectOption('High');
    });

    // 4. Click the Save or Submit button
    await test.step('Click the Save or Submit button', async () => {
      await page.getByRole('button', { name: 'Submit Ticket' }).click();
    });

    // Expect: The system displays a validation error indicating the assignee
    // field is required and the ticket is not created.
    await test.step('Expect: the system displays a validation error indicating the assignee field is required and the ticket is not created', async () => {
      await expect(page.getByText(/assignee.*required/i)).toBeVisible();
      await expect(page.getByRole('row', { name: data.title })).toHaveCount(0);
    });
  });
});
