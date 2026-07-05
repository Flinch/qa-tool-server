import { Page } from '@playwright/test';

export async function loginAsAdmin(page: Page) {
  await page.getByRole('textbox', {name: 'Enter your username'}).fill('Carol')
  await page.getByRole('textbox', {name: 'Enter your password'}).fill('admin')
  await page.getByRole('button', {name: 'Sign in'}).click()
}