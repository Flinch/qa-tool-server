# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: generated/e2e-critical-flow/tc-65-add-candidate-for-a-vacancy-and-progress-through-the-hiring.spec.ts >> TC-65 — Add candidate for a vacancy and progress through the hiring workflow to hired >> TC-65: Add candidate for a vacancy and progress through the hiring workflow to hired
- Location: tests/generated/e2e-critical-flow/tc-65-add-candidate-for-a-vacancy-and-progress-through-the-hiring.spec.ts:17:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('heading', { name: 'Add Vacancy' })
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('heading', { name: 'Add Vacancy' })

```

```yaml
- main:
  - paragraph:
    - strong: "404"
    - text: ": NOT_FOUND Code:"
    - code: "`NOT_FOUND`"
    - text: "ID:"
    - code: "`sfo1::tq8hx-1786086129659-3a26174f1eec`"
  - link "Read our documentation to learn more about this error.":
    - /url: https://vercel.com/docs/errors/NOT_FOUND
```

# Test source

```ts
  1  | // Creates a new Recruitment vacancy via Recruitment > Vacancies > Add with a unique,
  2  | // Date.now()-derived vacancy name, a selected Job Title, and a selected Hiring Manager, saves
  3  | // it, and waits for the resulting "Edit Vacancy" page to load. Reuse this for any scenario
  4  | // that needs a fresh, active vacancy to act on (e.g. adding candidates against it) instead of
  5  | // depending on shared demo vacancy data that may not exist or may drift.
  6  | import { Page, expect } from '@playwright/test';
  7  | 
  8  | export async function createVacancy(
  9  |   page: Page,
  10 |   overrides?: { vacancyName?: string; jobTitle?: string; hiringManagerQuery?: string }
  11 | ): Promise<{ vacancyName: string; jobTitle: string; hiringManager: string }> {
  12 |   const suffix = Date.now().toString().slice(-6);
  13 |   const vacancyName = overrides?.vacancyName ?? `QA Vacancy ${suffix}`;
  14 |   const jobTitle = overrides?.jobTitle ?? 'QA Engineer';
  15 |   // A specific hardcoded name (e.g. 'Daisy') can stop resolving to any
  16 |   // employee at all as this shared demo's data drifts over time — confirmed
  17 |   // live: the Hiring Manager autocomplete then never suggests anything, the
  18 |   // field stays unset, and Save silently fails validation (page stays on
  19 |   // "Add Vacancy"). A single common letter reliably matches many employees
  20 |   // on this instance regardless of which specific people currently exist,
  21 |   // and since any real employee works as a hiring manager here, which one
  22 |   // gets picked doesn't matter.
  23 |   const hiringManagerQuery = overrides?.hiringManagerQuery ?? 'a';
  24 | 
  25 |   await page.goto('/web/index.php/recruitment/addJobVacancy');
> 26 |   await expect(page.getByRole('heading', { name: 'Add Vacancy' })).toBeVisible();
     |                                                                    ^ Error: expect(locator).toBeVisible() failed
  27 | 
  28 |   // FRAGILE: Vacancy Name / Job Title / Hiring Manager selects have no accessible role/name
  29 |   // usable via getByRole/getByLabel; each is scoped by its own <label> text via the
  30 |   // oxd-input-group wrapper, verified live (same pattern used in createEmployee.ts's sibling
  31 |   // helpers for this app).
  32 |   const vacancyNameGroup = page.locator('.oxd-input-group').filter({ hasText: /^Vacancy Name/ });
  33 |   await vacancyNameGroup.locator('input').fill(vacancyName);
  34 | 
  35 |   const jobTitleGroup = page.locator('.oxd-input-group').filter({ hasText: /^Job Title/ });
  36 |   await jobTitleGroup.locator('.oxd-select-text').click();
  37 |   await page.getByRole('option', { name: jobTitle, exact: true }).click();
  38 | 
  39 |   const hiringManagerGroup = page.locator('.oxd-input-group').filter({ hasText: /^Hiring Manager/ });
  40 |   const hiringManagerInput = hiringManagerGroup.getByPlaceholder('Type for hints...');
  41 |   await hiringManagerInput.fill(hiringManagerQuery);
  42 |   // The autocomplete briefly renders a "Searching...." placeholder option
  43 |   // before real results populate (confirmed live) — wait for a real one,
  44 |   // not that placeholder, or the field can end up with nothing usable
  45 |   // selected.
  46 |   const suggestion = page.getByRole('option').filter({ hasNotText: 'Searching' }).first();
  47 |   await suggestion.waitFor();
  48 |   const hiringManager = (await suggestion.textContent())?.trim() ?? hiringManagerQuery;
  49 |   await suggestion.click();
  50 | 
  51 |   await page.getByRole('button', { name: 'Save' }).click();
  52 | 
  53 |   // The vacancy list defaults new vacancies to "Active" (Active checkbox checked) and
  54 |   // publishes them; the resulting page becomes "Edit Vacancy" for the same record, confirming
  55 |   // the save succeeded.
  56 |   await expect(page.getByRole('heading', { name: 'Edit Vacancy' })).toBeVisible();
  57 |   await expect(page).toHaveURL(/\/recruitment\/addJobVacancy\/\d+/);
  58 | 
  59 |   return { vacancyName, jobTitle, hiringManager };
  60 | }
  61 | 
```