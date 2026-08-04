// Logs out of whichever OrangeHRM identity is currently authenticated (via the topbar user
// dropdown) and logs in as the given username/password, waiting for the login form to be gone.
// Reuse this whenever a scenario needs to switch between two distinct identities mid-test (e.g.
// an employee applying for leave and a different, authorised approver acting on the request) —
// OrangeHRM blocks a user from approving their own request, so this kind of identity switch is a
// real, recurring part of the Leave module's business flow, not just incidental setup.
import { Page, expect } from '@playwright/test';

export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  // The `generated` project starts authenticated via storageState but with the page itself still
  // at about:blank until something navigates it — go to the dashboard first so the topbar (and
  // its user dropdown) actually exists to click, whether this is the very first call in a test or
  // a later one from an already-loaded page.
  await page.goto('/web/index.php/dashboard/index');

  // FRAGILE: the topbar profile toggle that opens the user dropdown (About/Support/Change
  // Password/Logout) has no accessible role or name (bare <span>/<img>/<p>, confirmed live) — it
  // is scoped by OrangeHRM's own stable class name instead.
  await page.locator('.oxd-userdropdown-tab').click();
  await page.getByRole('menuitem', { name: 'Logout' }).click();

  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Login' }).click();

  // Generic post-login assertion: true of any successful login, not tied to a specific user's
  // post-login display name.
  await expect(page).not.toHaveURL(/\/auth\/login/);
  await expect(page.getByRole('button', { name: 'Login' })).toHaveCount(0);
}
