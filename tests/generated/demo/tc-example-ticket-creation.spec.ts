// spec: specs/tc-example-ticket-creation.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTestData } from '../../../helpers/testData';

test.describe('TC-EXAMPLE — user can submit a ticket and see it listed', () => {
  test('TC-EXAMPLE: user can submit a ticket and see it listed', async ({ page }) => {
    const data = createTestData();
    const attachmentDescription = 'No attachment - text description only';

    await page.goto('/');

    // 1. Click the "New Ticket" button
    await test.step('Click the "New Ticket" button', async () => {
      await page.getByRole('button', { name: 'New Ticket' }).first().click();
    });

    // 2. Fill "Brief summary of the issue" with a unique title
    await test.step('Fill "Brief summary of the issue" with a unique title', async () => {
      const titleBox = page.getByRole('textbox', { name: 'Brief summary of the issue' });
      await titleBox.click();
      await titleBox.fill(data.title);
    });

    // 3. Fill "Describe the issue in detail" with a description
    await test.step('Fill "Describe the issue in detail" with a description', async () => {
      const descriptionBox = page.getByRole('textbox', { name: 'Describe the issue in detail' });
      await descriptionBox.click();
      await descriptionBox.fill(data.description);
    });

    // 4. Select category "Software" and priority "High"
    await test.step('Select category "Software" and priority "High"', async () => {
      // The Category/Priority <select> elements in the New Ticket modal have no
      // accessible name (no <label for>, no wrapping, no aria-label), so
      // getByLabel/getByRole-with-name cannot target them. Scoping to the
      // modal (which contains exactly these 2 comboboxes) and selecting by
      // position is the least-fragile option confirmed via a live snapshot.
      // FRAGILE: positional combobox lookup scoped to `.modal` container.
      const modal = page.locator('.modal');
      await modal.getByRole('combobox').nth(0).selectOption('Software');
      await modal.getByRole('combobox').nth(1).selectOption('High');
    });

    // 5. Fill the attachment description field
    await test.step('Fill the attachment description field', async () => {
      const attachmentBox = page.getByRole('textbox', { name: 'Filename or description of attachment' });
      await attachmentBox.click();
      await attachmentBox.fill(attachmentDescription);
    });

    // 6. Click "Submit Ticket"
    await test.step('Click "Submit Ticket"', async () => {
      await page.getByRole('button', { name: 'Submit Ticket' }).click();
    });

    // Expect: the new ticket appears in the ticket list with the unique title,
    // status "Open", and priority "High".
    await test.step('Expect: the new ticket appears in the ticket list with the unique title, status "Open", and priority "High"', async () => {
      const row = page.getByRole('row', { name: data.title });
      await expect(row).toContainText('Open');
      await expect(row).toContainText('High');
    });
  });
});
