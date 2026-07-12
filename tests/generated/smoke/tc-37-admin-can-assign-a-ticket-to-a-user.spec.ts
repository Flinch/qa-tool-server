// spec: specs/tc-37-admin-can-assign-a-ticket-to-a-user.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTicket } from '../../../helpers/createTicket';

test.describe('Admin can assign a ticket to a user', () => {
  test('TC-37: Admin can assign a ticket to a user', async ({ page }) => {
    await page.goto('/');

    // Setup: Create a fresh ticket with createTicket(page) (helpers/createTicket.ts).
    // The creation modal has no assignee field, so this ticket starts as Unassigned.
    const data = await createTicket(page);

    // 1. Login as an admin user (already satisfied by storageState — no login step in the generated test).

    // 2. Navigate to the tickets list: click the "All Tickets" sidebar item.
    await test.step('Navigate to the tickets list: click the "All Tickets" sidebar item', async () => {
      await page.getByText('All Tickets').click();
    });

    // 3. Open the newly created (unassigned) ticket by clicking its row in the tickets table; this navigates to the ticket detail view.
    const row = page.getByRole('row', { name: data.title });
    await test.step('Open the newly created (unassigned) ticket by clicking its row in the tickets table', async () => {
      await row.click();
    });

    // 4. In the Assignee panel (initially "No agent assigned"), click the "Assign" button, then select a user (e.g. "Bob Martinez (agent)") from the combobox that appears.
    await test.step('In the Assignee panel, click the "Assign" button, then select a user from the combobox that appears', async () => {
      await page.getByRole('button', { name: 'Assign' }).click();
      // The combobox is the only one on the ticket detail page, so getByRole('combobox')
      // is safe here without needing .nth().
      await page.getByRole('combobox').selectOption('Bob Martinez (agent)');
    });

    // 5. The assignment saves automatically on selection — there is no separate Save button.
    // A "Ticket updated" toast appears immediately (assert on it before it auto-dismisses).
    await test.step('The assignment saves automatically; assert the "Ticket updated" toast appears immediately', async () => {
      await expect(page.getByText('Ticket updated')).toBeVisible();
    });

    // Expect: The Assignee panel updates in place to show the selected user, and the assignment
    // persists (after reload, the ticket's row in the All Tickets list shows the assignee in the Assignee column).
    await test.step('Expect: the Assignee panel updates in place to the selected user, and the assignment persists after reload in the All Tickets list Assignee column', async () => {
      await expect(page.getByText('Bob Martinez')).toBeVisible();

      await page.goto('/');
      const listRow = page.getByRole('row', { name: data.title });
      await expect(listRow).toContainText('Bob Martinez');
    });
  });
});
