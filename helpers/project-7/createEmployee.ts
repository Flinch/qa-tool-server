// Creates a new employee via PIM > Add Employee with a unique, Date.now()-derived first/last
// name, waits for the "Successfully Saved" toast and the navigation to the new employee's
// Personal Details page, then returns the generated name and empNumber. Reuse this for any
// scenario that needs a fresh employee record to act on (e.g. edit/terminate/delete flows).
import { Page, expect } from '@playwright/test';

export async function createEmployee(
  page: Page,
  overrides?: { firstName?: string; lastName?: string }
): Promise<{ firstName: string; lastName: string; empNumber: string }> {
  const suffix = Date.now().toString().slice(-6);
  const firstName = overrides?.firstName ?? `QAFirst${suffix}`;
  const lastName = overrides?.lastName ?? `QALast${suffix}`;

  await page.goto('/web/index.php/pim/addEmployee');
  await page.getByRole('textbox', { name: 'First Name' }).fill(firstName);
  await page.getByRole('textbox', { name: 'Last Name' }).fill(lastName);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Successfully Saved')).toBeVisible();
  // The save round-trip can take a few seconds before the client-side route change to
  // viewPersonalDetails begins (timing only), so this navigation assertion needs more than the
  // 5s default.
  await expect(page).toHaveURL(/\/pim\/viewPersonalDetails\/empNumber\/\d+/, { timeout: 30000 });

  const match = page.url().match(/empNumber\/(\d+)/);
  const empNumber = match ? match[1] : '';

  return { firstName, lastName, empNumber };
}
