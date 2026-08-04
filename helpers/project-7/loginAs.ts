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
  // a later one from an already-loaded page. A genuinely unauthenticated context (the
  // 'generated-self-auth' project — see playwright.config.js's SELF_AUTH_SPECS) instead gets
  // redirected straight to the login page by this same navigation, which the check below handles.
  await page.goto('/web/index.php/dashboard/index');

  // Only log out if a session is actually active. Skipping this for an already-unauthenticated
  // context isn't just an optimization: this helper's very first call in a test starts from
  // whatever session the project's context inherited, and clicking Logout on an inherited session
  // destroys it server-side — for the shared 'generated' project's single storageState, that
  // kills every OTHER concurrently-running test still holding that same cookie, mid-test
  // (confirmed live: this silently failed two unrelated tests in every suite run before
  // identity-switching specs got their own unauthenticated project). Not an issue for
  // 'generated-self-auth', which never shares a session with anything else to begin with — this
  // check just also makes the helper correct to call from a context that was never logged in.
  //
  // FRAGILE: the topbar profile toggle that opens the user dropdown (About/Support/Change
  // Password/Logout) has no accessible role or name (bare <span>/<img>/<p>, confirmed live) — it
  // is scoped by OrangeHRM's own stable class name instead.
  const userDropdown = page.locator('.oxd-userdropdown-tab');
  const alreadyAuthenticated = await userDropdown.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (alreadyAuthenticated) {
    await userDropdown.click();
    await page.getByRole('menuitem', { name: 'Logout' }).click();
  }

  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Login' }).click();

  // Generic post-login assertion: true of any successful login, not tied to a specific user's
  // post-login display name.
  await expect(page).not.toHaveURL(/\/auth\/login/);
  await expect(page.getByRole('button', { name: 'Login' })).toHaveCount(0);
}
