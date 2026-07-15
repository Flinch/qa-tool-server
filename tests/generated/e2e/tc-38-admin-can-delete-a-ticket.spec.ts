// spec: specs/tc-38-admin-can-delete-a-ticket.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTicket } from '../../../helpers/createTicket';

test.describe('Admin can delete a ticket', () => {
  test('TC-38: Admin can delete a ticket', async ({ page }) => {
    await page.goto('/');

    // 1. Create a new ticket with a unique title (via the "New Ticket" button: fill "Brief summary of the issue", "Describe the issue in detail", select a Category and Priority, then click "Submit Ticket")
    const data = await test.step(
      'Create a new ticket with a unique title (via the "New Ticket" button: fill "Brief summary of the issue", "Describe the issue in detail", select a Category and Priority, then click "Submit Ticket")',
      async () => createTicket(page)
    );

    // 2. Locate the row for the newly created ticket in the tickets list, identified by its unique title
    const row = page.getByRole('row', { name: data.title });
    await test.step('Locate the row for the newly created ticket in the tickets list, identified by its unique title', async () => {
      await expect(row).toBeVisible();
    });

    // 3. Click the "Delete ticket" button in that ticket's row
    await test.step('Click the "Delete ticket" button in that ticket\'s row', async () => {
      await row.getByRole('button', { name: 'Delete ticket' }).click();
    });

    // 4. In the "Delete ticket?" confirmation dialog, click the "Delete" button to confirm
    await test.step('In the "Delete ticket?" confirmation dialog, click the "Delete" button to confirm', async () => {
      // The dialog's confirm button shares the substring "Delete" with every row's
      // "Delete ticket" button (accessible name computed from a title attribute),
      // so a plain getByRole('button', { name: 'Delete' }) risks matching more than
      // one element depending on ARIA name resolution. The dialog exposes a stable
      // data-testid for exactly this action, confirmed unique via a live DOM check.
      await page.getByTestId('confirm-delete').click();
    });

    // Expect: A "Ticket deleted" toast appears immediately after confirming, and the row for the created ticket's unique title no longer appears anywhere in the tickets list.
    await test.step('Expect: A "Ticket deleted" toast appears immediately after confirming, and the row for the created ticket\'s unique title no longer appears anywhere in the tickets list', async () => {
      await expect(page.getByText('Ticket deleted')).toBeVisible();
      await expect(row).toHaveCount(0);
    });
  });
});
