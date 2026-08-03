// Creates a new Recruitment vacancy via Recruitment > Vacancies > Add with a unique,
// Date.now()-derived vacancy name, a selected Job Title, and a selected Hiring Manager, saves
// it, and waits for the resulting "Edit Vacancy" page to load. Reuse this for any scenario
// that needs a fresh, active vacancy to act on (e.g. adding candidates against it) instead of
// depending on shared demo vacancy data that may not exist or may drift.
import { Page, expect } from '@playwright/test';

export async function createVacancy(
  page: Page,
  overrides?: { vacancyName?: string; jobTitle?: string; hiringManagerQuery?: string }
): Promise<{ vacancyName: string; jobTitle: string; hiringManager: string }> {
  const suffix = Date.now().toString().slice(-6);
  const vacancyName = overrides?.vacancyName ?? `QA Vacancy ${suffix}`;
  const jobTitle = overrides?.jobTitle ?? 'QA Engineer';
  // A specific hardcoded name (e.g. 'Daisy') can stop resolving to any
  // employee at all as this shared demo's data drifts over time — confirmed
  // live: the Hiring Manager autocomplete then never suggests anything, the
  // field stays unset, and Save silently fails validation (page stays on
  // "Add Vacancy"). A single common letter reliably matches many employees
  // on this instance regardless of which specific people currently exist,
  // and since any real employee works as a hiring manager here, which one
  // gets picked doesn't matter.
  const hiringManagerQuery = overrides?.hiringManagerQuery ?? 'a';

  await page.goto('/web/index.php/recruitment/addJobVacancy');
  await expect(page.getByRole('heading', { name: 'Add Vacancy' })).toBeVisible();

  // FRAGILE: Vacancy Name / Job Title / Hiring Manager selects have no accessible role/name
  // usable via getByRole/getByLabel; each is scoped by its own <label> text via the
  // oxd-input-group wrapper, verified live (same pattern used in createEmployee.ts's sibling
  // helpers for this app).
  const vacancyNameGroup = page.locator('.oxd-input-group').filter({ hasText: /^Vacancy Name/ });
  await vacancyNameGroup.locator('input').fill(vacancyName);

  const jobTitleGroup = page.locator('.oxd-input-group').filter({ hasText: /^Job Title/ });
  await jobTitleGroup.locator('.oxd-select-text').click();
  await page.getByRole('option', { name: jobTitle, exact: true }).click();

  const hiringManagerGroup = page.locator('.oxd-input-group').filter({ hasText: /^Hiring Manager/ });
  const hiringManagerInput = hiringManagerGroup.getByPlaceholder('Type for hints...');
  await hiringManagerInput.fill(hiringManagerQuery);
  // The autocomplete briefly renders a "Searching...." placeholder option
  // before real results populate (confirmed live) — wait for a real one,
  // not that placeholder, or the field can end up with nothing usable
  // selected.
  const suggestion = page.getByRole('option').filter({ hasNotText: 'Searching' }).first();
  await suggestion.waitFor();
  const hiringManager = (await suggestion.textContent())?.trim() ?? hiringManagerQuery;
  await suggestion.click();

  await page.getByRole('button', { name: 'Save' }).click();

  // The vacancy list defaults new vacancies to "Active" (Active checkbox checked) and
  // publishes them; the resulting page becomes "Edit Vacancy" for the same record, confirming
  // the save succeeded.
  await expect(page.getByRole('heading', { name: 'Edit Vacancy' })).toBeVisible();
  await expect(page).toHaveURL(/\/recruitment\/addJobVacancy\/\d+/);

  return { vacancyName, jobTitle, hiringManager };
}
