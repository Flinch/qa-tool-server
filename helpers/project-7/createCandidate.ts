// Creates a new Recruitment candidate via Recruitment > Candidates > Add Candidate against a
// given vacancy name, with a unique Date.now()-derived full name and email, saves it, and waits
// for the resulting "Application Stage" page (status "Application Initiated") to load. Reuse
// this for any scenario that needs a fresh candidate application to act on or progress through
// the hiring workflow.
import { Page, expect } from '@playwright/test';

export async function createCandidate(
  page: Page,
  vacancyName: string,
  overrides?: { firstName?: string; lastName?: string; email?: string }
): Promise<{ fullName: string; firstName: string; lastName: string; email: string; candidateId: string }> {
  const suffix = Date.now().toString().slice(-6);
  const firstName = overrides?.firstName ?? 'QACandidate';
  const lastName = overrides?.lastName ?? suffix;
  const email = overrides?.email ?? `qacandidate${suffix}@example.com`;
  const fullName = `${firstName} ${lastName}`;

  await page.goto('/web/index.php/recruitment/addCandidate');
  await expect(page.getByRole('heading', { name: 'Add Candidate' })).toBeVisible();

  await page.getByRole('textbox', { name: 'First Name' }).fill(firstName);
  await page.getByRole('textbox', { name: 'Last Name' }).fill(lastName);

  // FRAGILE: the Vacancy select has no accessible role/name usable via getByRole/getByLabel;
  // scoped by its own <label> text via the oxd-input-group wrapper, verified live.
  const vacancyGroup = page.locator('.oxd-input-group').filter({ hasText: /^Vacancy$/ });
  await vacancyGroup.locator('.oxd-select-text').click();
  await page.getByRole('option', { name: vacancyName, exact: true }).click();

  // FRAGILE: the Email input shares its generic "Type here" placeholder with Contact Number;
  // it's the first such field on this form, verified live.
  await page.getByRole('textbox', { name: 'Type here' }).first().fill(email);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/recruitment\/addCandidate\/\d+/);
  await expect(page.getByRole('heading', { name: 'Application Stage' })).toBeVisible();

  const match = page.url().match(/addCandidate\/(\d+)/);
  const candidateId = match ? match[1] : '';

  return { fullName, firstName, lastName, email, candidateId };
}
