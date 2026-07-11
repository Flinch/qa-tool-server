import { test as setup, expect } from '@playwright/test';
import { loginAsAdmin, TEST_USER } from '../helpers/auth';

const authFile = process.env.STORAGE_STATE || '.auth/user.json';

// Runs once before the `generated` project (see playwright.config.js
// `dependencies`). Logs in and persists cookies + localStorage so every
// generated test starts authenticated without repeating login steps.
setup('authenticate', async ({ page }) => {
  await page.goto('/');
  await loginAsAdmin(page);
  await expect(page.locator('.sidebar-user-name')).toHaveText(TEST_USER.displayName);
  await page.context().storageState({ path: authFile });
});
