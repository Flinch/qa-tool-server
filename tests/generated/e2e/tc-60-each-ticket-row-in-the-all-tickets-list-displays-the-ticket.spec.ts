// spec: specs/tc-60-each-ticket-row-in-the-all-tickets-list-displays-the-ticket.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTicket } from '../../../helpers/createTicket';

test.describe('All Tickets list', () => {
  test("TC-60: Each ticket row in the All Tickets list displays the ticket's priority", async ({ page }) => {
    let data: Awaited<ReturnType<typeof createTicket>>;

    await page.goto('/');

    // 1. Create a ticket with a known priority of 'High' via createTicket(page) — returns TestData with a unique .title
    await test.step("Create a ticket with a known priority of 'High' via createTicket(page)", async () => {
      data = await createTicket(page);
    });

    // 2. Navigate to the All Tickets list by clicking the 'All Tickets' nav item
    await test.step("Navigate to the All Tickets list by clicking the 'All Tickets' nav item", async () => {
      // The "All Tickets" nav item is a plain div.nav-item (no link/button role,
      // no testid), so getByRole does not apply here.
      await page.getByText('All Tickets').click();
    });

    // 3. Locate the created ticket's row via page.getByRole('row', { name: TestData.title }) and inspect its priority
    // Expect: the created ticket's row displays the priority value set during creation
    await test.step("Expect: the created ticket's row displays the priority value set during creation", async () => {
      const row = page.getByRole('row', { name: data.title });
      await expect(row).toContainText('High');
    });
  });
});
