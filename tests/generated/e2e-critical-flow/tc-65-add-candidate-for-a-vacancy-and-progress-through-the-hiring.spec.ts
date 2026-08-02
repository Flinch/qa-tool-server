// spec: specs/tc-65-add-candidate-for-a-vacancy-and-progress-through-the-hiring.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createVacancy } from '../../../helpers/project-7/createVacancy';
import { createCandidate } from '../../../helpers/project-7/createCandidate';

// The list's "Date of Application" column (and the Add Candidate/Interview date inputs) render
// in yyyy-dd-mm order (day before month, confirmed live: values like "2024-29-03" are only
// valid if day=29/month=03) rather than the standard yyyy-mm-dd — same quirk documented in
// helpers/project-7/createEmployee.ts's sibling spec for this app's date inputs.
function parseListDate(text: string): Date {
  const [year, day, month] = text.split('-').map(Number);
  return new Date(year, month - 1, day);
}

test.describe('TC-65 — Add candidate for a vacancy and progress through the hiring workflow to hired', () => {
  test('TC-65: Add candidate for a vacancy and progress through the hiring workflow to hired', async ({ page }) => {
    // This is a long multi-page e2e flow (create vacancy -> create candidate -> two list
    // searches/sorts -> five sequential workflow-stage transitions) against a live shared demo
    // app, so raise the test timeout (timing/stability only).
    test.setTimeout(150_000);

    let vacancyName = '';
    let hiringManager = '';
    let candidateFullName = '';
    let candidateId = '';

    // 1. Navigate to Recruitment > Vacancies and confirm at least one active vacancy exists; if
    // none exists, create one first via Recruitment > Vacancies > Add using a unique job title,
    // so this test does not depend on pre-existing shared demo data.
    await test.step('Navigate to Recruitment > Vacancies and confirm at least one active vacancy exists; if none exists, create one first via Recruitment > Vacancies > Add using a unique job title, so this test does not depend on pre-existing shared demo data', async () => {
      // DESIGN NOTE (not a mismatch): live verification found active vacancies already present
      // in this shared demo (e.g. "Payroll Administrator" - Active). Rather than branching on
      // that shared, ever-changing state (which the next run cannot rely on either), this test
      // always creates its own fresh vacancy via createVacancy(page) — the strongest way to
      // satisfy the plan's actual goal ("does not depend on pre-existing shared demo data") and
      // to keep the test passing twice in a row regardless of what other runs do to the shared
      // vacancy list.
      const created = await createVacancy(page);
      vacancyName = created.vacancyName;
      hiringManager = created.hiringManager;

      // Expect: the vacancy is saved, defaults to Active, and the page becomes "Edit Vacancy"
      // for the new record (already asserted inside createVacancy). Confirm it's discoverable
      // by name in the Vacancies list.
      await page.goto('/web/index.php/recruitment/viewJobVacancy');
      const vacancyRow = page.getByRole('row', { name: new RegExp(vacancyName) });
      await expect(vacancyRow).toBeVisible();
      await expect(vacancyRow).toContainText('Active');
    });

    // 2. Navigate to Recruitment > Candidates > Add Candidate
    // 3. Select the target job vacancy, enter the candidate's full name (unique per run), specify
    // the hiring manager, and set the application method
    // 4. Save the candidate record
    await test.step("Navigate to Recruitment > Candidates > Add Candidate, select the target job vacancy, enter the candidate's unique full name, and save the candidate record", async () => {
      // CLARIFICATION (not a mismatch): the Add Candidate form has no separate "Hiring Manager"
      // or "Application Method" input — Hiring Manager is inherited automatically from the
      // selected vacancy (confirmed live: it shows read-only on the resulting Application Stage
      // page), and "Method of Application" only exists as a Candidates-list search filter, not a
      // settable field on this form. Both are still effectively captured (hiring manager via
      // vacancy assignment); there is nothing to separately fill in here.
      const created = await createCandidate(page, vacancyName);
      candidateFullName = created.fullName;
      candidateId = created.candidateId;

      // Expect: the candidate is saved against the vacancy, with the vacancy's hiring manager
      // captured, and starts in status "Application Initiated" (already asserted inside
      // createCandidate that the Application Stage page loads).
      await expect(page.getByText(candidateFullName, { exact: true })).toBeVisible();
      await expect(page.getByText(vacancyName, { exact: true })).toBeVisible();
      await expect(page.getByText(hiringManager, { exact: true })).toBeVisible();
      await expect(page.getByText('Status: Application Initiated')).toBeVisible();
    });

    // 5. Navigate to the Candidates list and search for the new candidate by name and vacancy to
    // confirm the record appears
    await test.step('Navigate to the Candidates list and search for the new candidate by name and vacancy to confirm the record appears', async () => {
      await page.goto('/web/index.php/recruitment/viewCandidates');

      // FRAGILE: the Candidate Name field is an autocomplete that requires selecting a
      // suggestion (not just typed text) before Search actually filters — confirmed live:
      // Search with unselected typed text still returned all records.
      const candidateNameInput = page.getByRole('textbox', { name: 'Type for hints...' }).first();
      await candidateNameInput.fill('QACandidate');
      await page.getByRole('option', { name: candidateFullName }).click();

      // FRAGILE: the Vacancy filter select has no accessible role/name; scoped by its own
      // <label> text via the oxd-input-group wrapper, verified live.
      const vacancyFilterGroup = page.locator('.oxd-input-group').filter({ hasText: /^Vacancy$/ });
      await vacancyFilterGroup.locator('.oxd-select-text').click();
      await page.getByRole('option', { name: vacancyName, exact: true }).click();

      await page.getByRole('button', { name: 'Search' }).click();

      // Expect: filtering by name + vacancy returns exactly the new record.
      await expect(page.getByText('(1) Record Found')).toBeVisible();
      const row = page.getByRole('row', { name: new RegExp(`${vacancyName}.*${candidateFullName}`) });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Application Initiated');
    });

    // 6. Sort the candidate list by Date of Application and verify the new candidate appears in
    // the correct position relative to its neighbors
    await test.step('Sort the candidate list by Date of Application and verify the new candidate appears in the correct position relative to its neighbors', async () => {
      await page.getByRole('button', { name: 'Reset' }).click();

      // FRAGILE: scoped to the "Date of Application" header — every column header renders its
      // own hidden Ascending/Descending menu in the DOM, so an unscoped click/text lookup would
      // be ambiguous, verified live (same pattern as the PIM Id-column sort in
      // tc-63/tc-62-style specs for this app).
      const dateHeader = page.locator('.oxd-table-header-cell', { hasText: 'Date of Application' }).first();
      await dateHeader.locator('.oxd-icon').first().click();
      await dateHeader.getByText('Descending', { exact: true }).click();

      // The candidate list is large and shared (65+ records on this public demo) and dates are
      // rendered day-before-month (see parseListDate above). Rather than asserting a fixed
      // absolute index (brittle against this shared demo's ever-changing dataset), sweep every
      // pagination page collecting (Candidate name, Date of Application) pairs and confirm the
      // new candidate's row sits correctly between its immediate neighbors in descending date
      // order. Wrapped in expect.toPass() to tolerate the brief re-render after the sort click.
      await expect(async () => {
        const pagination = page.getByRole('navigation', { name: 'Pagination Navigation' });
        const bodyRows = page.getByRole('row').filter({ has: page.getByRole('cell') });

        const page1Button = pagination.getByRole('button', { name: '1', exact: true });
        if ((await page1Button.count()) > 0) {
          await page1Button.click();
          await expect(bodyRows.first()).toBeVisible();
        }

        const entries: { name: string; date: string }[] = [];
        while (true) {
          const rowCount = await bodyRows.count();
          for (let r = 0; r < rowCount; r++) {
            const cells = bodyRows.nth(r).getByRole('cell');
            // Cell order is fixed: [checkbox, Vacancy, Candidate, Hiring Manager,
            // Date of Application, Status, Actions] — verified live, holds even when Vacancy
            // is blank (deleted vacancy rows still render an empty cell in that slot).
            const name = (await cells.nth(2).textContent())?.trim() ?? '';
            const date = (await cells.nth(4).textContent())?.trim() ?? '';
            entries.push({ name, date });
          }

          // FRAGILE: the "Next" arrow has no accessible name and shares its button class with
          // "Previous"; identified by its chevron icon class, verified live. Absent on the last
          // page.
          const nextButton = pagination.locator('button:has(.bi-chevron-right)');
          if ((await nextButton.count()) === 0) break;
          await nextButton.click();
          await expect(bodyRows.first()).toBeVisible();
        }

        const idx = entries.findIndex((e) => e.name === candidateFullName);
        expect(idx).toBeGreaterThan(-1);
        const targetDate = parseListDate(entries[idx].date);
        if (idx > 0) {
          const prevDate = parseListDate(entries[idx - 1].date);
          expect(prevDate.getTime()).toBeGreaterThanOrEqual(targetDate.getTime());
        }
        if (idx < entries.length - 1) {
          const nextDate = parseListDate(entries[idx + 1].date);
          expect(nextDate.getTime()).toBeLessThanOrEqual(targetDate.getTime());
        }
      }).toPass();
    });

    // 7. Open the candidate record and advance the status to Shortlisted
    await test.step('Open the candidate record and advance the status to Shortlisted', async () => {
      await page.goto(`/web/index.php/recruitment/addCandidate/${candidateId}`);
      await page.getByRole('button', { name: 'Shortlist' }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      // Expect: the candidate's status becomes Shortlisted and the next-stage action
      // ("Schedule Interview") becomes available.
      await expect(page.getByText('Status: Shortlisted')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Schedule Interview' })).toBeVisible();
    });

    // 8. Schedule an interview for the candidate
    await test.step('Schedule an interview for the candidate', async () => {
      await page.getByRole('button', { name: 'Schedule Interview' }).click();

      await page.getByRole('textbox', { name: 'Interview Title' }).fill('First Round Interview');

      const interviewerInput = page.getByRole('textbox', { name: 'Type for hints...' });
      await interviewerInput.fill('Daisy');
      await page.getByRole('option', { name: 'Daisy Nguyen' }).click();

      // FRAGILE: the date input's accessible name is its placeholder text, which is
      // "yyyy-dd-mm" (day before month), not standard ISO order — verified live.
      const today = new Date();
      const todayForField = `${today.getFullYear()}-${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      await page.getByRole('textbox', { name: 'yyyy-dd-mm' }).fill(todayForField);

      await page.getByRole('button', { name: 'Save' }).click();

      // Expect: the candidate's status becomes Interview Scheduled and Passed/Failed actions
      // become available.
      await expect(page.getByText('Status: Interview Scheduled')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Mark Interview Passed' })).toBeVisible();
    });

    // 9. Mark the scheduled interview's outcome as Passed
    await test.step("Mark the scheduled interview's outcome as Passed", async () => {
      await page.getByRole('button', { name: 'Mark Interview Passed' }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      // Expect: the candidate's status becomes Interview Passed and "Offer Job" becomes
      // available.
      await expect(page.getByText('Status: Interview Passed')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Offer Job' })).toBeVisible();
    });

    // 10. Extend a job offer to the candidate
    await test.step('Extend a job offer to the candidate', async () => {
      await page.getByRole('button', { name: 'Offer Job' }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      // Expect: the candidate's status becomes Job Offered and "Hire" becomes available.
      await expect(page.getByText('Status: Job Offered')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Hire' })).toBeVisible();
    });

    // 11. Mark the candidate as Hired and save
    await test.step('Mark the candidate as Hired and save', async () => {
      await page.getByRole('button', { name: 'Hire' }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      // Expect: the candidate's status becomes the terminal Hired state.
      await expect(page.getByText('Status: Hired')).toBeVisible();
    });

    // 12. Return to the Candidates list and verify the candidate's status column reflects Hired
    await test.step("Return to the Candidates list and verify the candidate's status column reflects Hired", async () => {
      await page.goto('/web/index.php/recruitment/viewCandidates');

      const candidateNameInput = page.getByRole('textbox', { name: 'Type for hints...' }).first();
      await candidateNameInput.fill('QACandidate');
      await page.getByRole('option', { name: candidateFullName }).click();
      await page.getByRole('button', { name: 'Search' }).click();

      // Final business-outcome assertion: the candidate progressed through the full hiring
      // workflow and the Candidates list's Status column reflects Hired.
      await expect(page.getByText('(1) Record Found')).toBeVisible();
      const row = page.getByRole('row', { name: new RegExp(candidateFullName) });
      await expect(row).toContainText('Hired');
    });
  });
});
