import { Page } from '@playwright/test';

// Credentials come from env so CI can use GitHub secrets and the agents
// never see hardcoded values in specs. Falls back to the demo account so
// local runs keep working without a .env.
export const TEST_USER = {
  name: process.env.TEST_USER_NAME || 'Carol',
  password: process.env.TEST_USER_PASSWORD || 'admin',
  displayName: process.env.TEST_USER_DISPLAY_NAME || 'Carol Kim',
};

export async function loginAsAdmin(page: Page) {
  await page.getByRole('textbox', { name: 'Enter your username' }).fill(TEST_USER.name);
  await page.getByRole('textbox', { name: 'Enter your password' }).fill(TEST_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
