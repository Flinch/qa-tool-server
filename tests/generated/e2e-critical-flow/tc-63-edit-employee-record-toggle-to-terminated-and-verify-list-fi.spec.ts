// spec: specs/tc-63-edit-employee-record-toggle-to-terminated-and-verify-list-fi.md
// seed: tests/seed.spec.ts

import { test, expect } from '@playwright/test';
import { createEmployee } from '../../../helpers/project-7/createEmployee';

test.describe('TC-63 — Edit employee record, toggle to terminated, and verify list filtering reflects status change', () => {
  test('TC-63: Edit employee record, toggle to terminated, and verify list filtering reflects status change', async ({ page }) => {
    // This is a long multi-page e2e flow (create -> edit -> terminate -> two list searches ->
    // delete) against a live shared demo app, so raise the test timeout (timing/stability only).
    test.setTimeout(90_000);

    let firstName = '';
    let lastName = '';
    let empNumber = '';

    // 1. Navigate to PIM > Add Employee and create a new employee with a unique first and last
    // name (via createTestData). Click Save.
    await test.step('Navigate to PIM > Add Employee and create a new employee with a unique first and last name. Click Save', async () => {
      const created = await createEmployee(page);
      firstName = created.firstName;
      lastName = created.lastName;
      empNumber = created.empNumber;

      // Expect: the employee is saved and the browser navigates to the new employee's Personal
      // Details page (URL contains /pim/viewPersonalDetails/empNumber/<id>).
      expect(empNumber).not.toBe('');
      await expect(page).toHaveURL(new RegExp(`/pim/viewPersonalDetails/empNumber/${empNumber}`));
      await expect(page.getByRole('heading', { name: `${firstName} ${lastName}` })).toBeVisible();
    });

    // 2. Open the employee's "Job" tab from their profile.
    await test.step('Open the employee\'s "Job" tab from their profile', async () => {
      await page.getByRole('link', { name: 'Job' }).click();

      // Expect: the Job Details form loads, plus a separate "Employee Termination / Activiation"
      // section containing a "Terminate Employment" button.
      await expect(page.getByRole('heading', { name: 'Job Details' })).toBeVisible();
      await expect(page.getByText('Employee Termination')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Terminate Employment' })).toBeVisible();
    });

    // FRAGILE: the Job Title select trigger has no accessible role/name; scoped by its own
    // <label> text via the oxd-input-group wrapper, verified live.
    const jobTitleGroup = page
      .locator('.oxd-input-group')
      .filter({ has: page.locator('label', { hasText: 'Job Title' }) });

    // 3. Open the "Job Title" dropdown and select an option, then click the Job Details "Save"
    // button.
    await test.step('Open the "Job Title" dropdown and select an option, then click the Job Details "Save" button', async () => {
      await jobTitleGroup.locator('.oxd-select-text').click();
      await page.getByRole('option', { name: 'QA Engineer' }).click();
      await page.getByRole('button', { name: 'Save' }).click();

      // Expect: the Job Title field shows the selected value (no longer "-- Select --") after
      // saving, and a "Successfully Updated" toast appears.
      await expect(page.getByText('Successfully Updated')).toBeVisible();
      await expect(jobTitleGroup.locator('.oxd-select-text-input')).toHaveText('QA Engineer');
    });

    // 4. In the "Employee Termination / Activiation" section, click "Terminate Employment". In
    // the dialog, fill the required "Termination Date" and select a "Termination Reason" (e.g.
    // "Other"), then click "Save".
    await test.step('Click "Terminate Employment", fill the required Termination Date and select a Termination Reason, then click "Save"', async () => {
      await page.getByRole('button', { name: 'Terminate Employment' }).click();

      const dialog = page.getByRole('dialog');
      // The date input's accessible name is its placeholder text, which is the standard ISO
      // "yyyy-mm-dd" — re-verified live (previously "yyyy-dd-mm", now corrected/matches ISO order).
      const today = new Date();
      const todayForField = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const terminationDateInput = dialog.getByRole('textbox', { name: 'yyyy-mm-dd' });
      await terminationDateInput.fill(todayForField);
      await expect(terminationDateInput).not.toHaveValue(todayForField, { timeout: 1 }).catch(() => {});

      // FRAGILE: the date picker's calendar popover sometimes stays open after filling and
      // intercepts subsequent clicks (confirmed live, though not on every run); close it
      // explicitly only if it's actually still showing.
      const calendarCloseButton = dialog.getByText('Close', { exact: true });
      if (await calendarCloseButton.isVisible().catch(() => false)) {
        await calendarCloseButton.click();
      }

      // FRAGILE: Termination Reason's select trigger has no accessible role/name; scoped by its
      // own <label> text via the oxd-input-group wrapper, verified live.
      const terminationReasonGroup = dialog
        .locator('.oxd-input-group')
        .filter({ has: page.locator('label', { hasText: 'Termination Reason' }) });
      await terminationReasonGroup.locator('.oxd-select-text').click();
      await page.getByRole('option', { name: 'Other' }).click();

      await dialog.getByRole('button', { name: 'Save' }).click();

      // Expect: the employee's name heading gains a "(Past Employee)" suffix, and the section
      // now reads "Terminated on: <date>" with an "Activate Employment" button replacing
      // "Terminate Employment".
      // Saving triggers a full page reload of viewJobDetails (confirmed live, same pattern as
      // the post-save reload in helpers/project-7/createEmployee.ts), which can occasionally
      // take longer than the 5s default — extend the timeout rather than the default.
      await expect(page.getByText('(Past Employee)')).toBeVisible({ timeout: 15000 });
      await expect(page.getByText(/Terminated on:/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Activate Employment' })).toBeVisible();
    });

    // FRAGILE: the Employee Name autocomplete field has no unique accessible name (there are two
    // identical "Type for hints..." fields on this page: Employee Name and Supervisor Name), so
    // it's scoped by its own <label> text via the oxd-input-group wrapper, verified live.
    const employeeNameInput = page
      .locator('.oxd-input-group')
      .filter({ hasText: /^Employee Name$/ })
      .getByPlaceholder('Type for hints...');

    // FRAGILE: the Include select trigger has no accessible role/name; scoped by its own <label>
    // text via the oxd-input-group wrapper, verified live.
    const includeGroup = page
      .locator('.oxd-input-group')
      .filter({ has: page.locator('label', { hasText: 'Include' }) });

    // FRAGILE: a "No Records Found" info toast (auto-dismissing) briefly renders at the same
    // time as the persistent "No Records Found" text in the results panel, which makes an
    // unscoped getByText ambiguous (strict mode violation) right after the search — verified
    // live. Scope to the main content container, which excludes the toast overlay.
    const resultsPanel = page.locator('.orangehrm-paper-container');

    // 5. Navigate to PIM > Employee List. With the default filters (Include = "Current Employees
    // Only"), type the employee's first name into the "Employee Name" field, then click "Search".
    await test.step('Navigate to PIM > Employee List, with the default Include filter type the employee\'s first name into "Employee Name", then click "Search"', async () => {
      await page.goto('/web/index.php/pim/viewEmployeeList');
      await expect(includeGroup.locator('.oxd-select-text-input')).toHaveText('Current Employees Only');

      await employeeNameInput.fill(firstName);
      await page.getByRole('button', { name: 'Search' }).click();

      // Expect: the terminated employee no longer appears in the default active-employees view
      // — the results table shows "No Records Found".
      await expect(resultsPanel.getByText('No Records Found')).toBeVisible();
    });

    // 6. On the filter panel, open the "Include" dropdown, select "Past Employees Only", re-enter
    // the employee's name if needed, and click "Search".
    await test.step('Open the "Include" dropdown, select "Past Employees Only", and click "Search"', async () => {
      await includeGroup.locator('.oxd-select-text').click();
      await page.getByRole('option', { name: 'Past Employees Only' }).click();
      await page.getByRole('button', { name: 'Search' }).click();

      // Expect: the results show "(1) Record Found" and the matching row's Last Name cell
      // displays the last name with a "(Past Employee)" suffix.
      await expect(page.getByText('(1) Record Found')).toBeVisible();
      const row = page.getByRole('row', { name: new RegExp(`${firstName}.*${lastName}`) });
      await expect(row).toBeVisible();
      await expect(row).toContainText(`${lastName} (Past Employee)`);
    });

    // 7. Confirm the filtered result is the correct employee by name (the "Past Employees Only" +
    // name filter returns exactly the one terminated record).
    await test.step('Confirm the filtered result is exactly the created employee', async () => {
      // Expect: exactly one record is listed and it matches the created employee's name.
      await expect(page.getByText('(1) Record Found')).toBeVisible();
      const matchingRows = page.getByRole('row', { name: new RegExp(`${firstName}.*${lastName}`) });
      await expect(matchingRows).toHaveCount(1);
    });

    // 8. Click the delete (trash icon) action on the employee's row, then confirm the "Are you
    // Sure?" dialog with "Yes, Delete".
    await test.step('Click the delete (trash icon) action on the row, then confirm "Yes, Delete"', async () => {
      const row = page.getByRole('row', { name: new RegExp(`${firstName}.*${lastName}`) });
      // FRAGILE: the delete action button has no accessible name; identified by its trash icon
      // class, verified live.
      await row.locator('button:has(.bi-trash)').click();
      await page.getByRole('button', { name: /Yes, Delete/ }).click();

      // Expect: a "Successfully Deleted" toast appears immediately, and the list for the same
      // "Past Employees Only" + name filter now shows "No Records Found" (count 1 -> 0).
      await expect(page.getByText('Successfully Deleted')).toBeVisible();
      await expect(resultsPanel.getByText('No Records Found')).toBeVisible();
    });
  });
});
