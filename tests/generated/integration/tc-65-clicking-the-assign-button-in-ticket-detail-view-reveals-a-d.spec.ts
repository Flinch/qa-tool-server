// spec: specs/tc-65-clicking-the-assign-button-in-ticket-detail-view-reveals-a-d.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createTicket } from '../../../helpers/createTicket';

test.describe('Ticket detail assign', () => {
  test('TC-65: Clicking the Assign button in ticket detail view reveals a dropdown of available agents', async ({ page }) => {
    await page.goto('/');

    // Setup: Create a fresh ticket with createTicket(page) (helpers/createTicket.ts).
    // The creation modal has no assignee field, so this ticket starts as Unassigned —
    // required because the "Assign" button only appears in the Assignee panel of an
    // UNASSIGNED ticket.
    const data = await createTicket(page);

    // 1. Login as an admin user (already satisfied by storageState — no login step in the generated test).

    // 2. Navigate to the tickets list: click the "All Tickets" sidebar item, then open the
    // newly created (unassigned) ticket by clicking its row; this navigates to the ticket detail view.
    await test.step('Navigate to the tickets list: click the "All Tickets" sidebar item, then open the newly created (unassigned) ticket by clicking its row', async () => {
      await page.getByText('All Tickets').click();
      await page.getByRole('row', { name: data.title }).click();
    });

    // 3. In the Assignee panel (initially "No agent assigned"), click the "Assign" button.
    await test.step('In the Assignee panel, click the "Assign" button', async () => {
      await expect(page.getByText('No agent assigned')).toBeVisible();
      await page.getByRole('button', { name: 'Assign' }).click();
    });

    // 4. Observe the UI response: inspect the options available in the combobox that
    // replaced the Assign button. It is the only combobox on the ticket detail page,
    // so getByRole('combobox') is safe without .nth().
    await test.step('Inspect the combobox that replaced the Assign button', async () => {
      const combobox = page.getByRole('combobox');
      await expect(combobox).toBeVisible();
      // "Unassigned" is the default option's visible text; its value attribute is "",
      // so assert on the selected option's text rather than the select's value.
      // FRAGILE: option:checked is a CSS pseudo-class (no role-based matcher exists for the selected option).
      await expect(combobox.locator('option:checked')).toHaveText('Unassigned');
      await expect(combobox.locator('option')).toHaveText([
        'Unassigned',
        'Carol Kim (admin)',
        'Bob Martinez (agent)',
        'Ron Swanson (agent)',
      ]);
      await page.screenshot({ path: 'test-results/tc-65-assign-dropdown.png' });
    });

    // Expect: A dropdown (native select/combobox) appears in place of the Assign button,
    // populated with an "Unassigned" option (selected by default) plus one option per
    // registered user, confirming the dropdown is populated with at least one available agent.
    await test.step('Expect: the dropdown is populated with "Unassigned" plus at least one available agent option', async () => {
      const combobox = page.getByRole('combobox');
      await expect(combobox.locator('option')).toHaveCount(4);
      await expect(combobox.getByRole('option', { name: 'Bob Martinez (agent)' })).toBeAttached();
      await page.screenshot({ path: 'test-results/tc-65-assign-dropdown.png' });
      
    });

    
  });
});
