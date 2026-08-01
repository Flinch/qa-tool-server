import { test as setup, expect } from '@playwright/test';

const authFile = process.env.STORAGE_STATE || '.auth/user.json';

// OrangeHRM demo login (https://opensource-demo.orangehrmlive.com/). Falls
// back to the demo's own published credentials (Admin / admin123) so local
// runs keep working without env vars set, mirroring helpers/auth.ts's
// fallback pattern for the shared setup.
const USERNAME = process.env.TEST_USER_NAME || 'Admin';
const PASSWORD = process.env.TEST_USER_PASSWORD || 'admin123';

setup('authenticate', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('textbox', { name: 'Username' }).fill(USERNAME);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();

  // Generic post-login assertions: the login form is gone and the URL left
  // the login path — true of any successful login, not app-specific text.
  await expect(page).not.toHaveURL(/\/auth\/login/);
  await expect(page.getByRole('button', { name: 'Login' })).toHaveCount(0);

  await page.context().storageState({ path: authFile });
});
