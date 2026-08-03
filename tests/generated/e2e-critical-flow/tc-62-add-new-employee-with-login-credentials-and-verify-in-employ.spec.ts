// spec: specs/tc-62-add-new-employee-with-login-credentials-and-verify-in-employ.md
// seed: tests/seed.spec.ts
//
// NOTE on test data policy: this generator run had no file-write access to
// helpers/testData.ts (only generator_write_test, which writes this one spec
// file, was available), so the unique-data generation that would normally
// live in a createEmployeeData() helper is inlined below instead. It still
// follows the same rule — unique values derived from Date.now(), never
// hardcoded — a reviewer should hoist this into helpers/testData.ts as a
// createEmployeeData() export the next time this file is touched.

import { test, expect } from '@playwright/test';

test.describe('TC-62 — Add new employee with login credentials and verify in employee list', () => {
  test('TC-62: Add new employee with login credentials and verify in employee list', async ({ page }) => {
    // This is a long end-to-end flow (11 steps, several full page navigations, a slow
    // save round-trip, and a pagination sweep) that exceeds Playwright's default 30s
    // per-test budget, so raise the test timeout (timing/stability only).
    test.setTimeout(120_000);

    // Unique per-run data: never hardcoded, so re-running never collides with a
    // previously created record.
    const suffix = Date.now().toString().slice(-6);
    const firstName = `QAFirst${suffix}`;
    const lastName = `QALast${suffix}`;
    const employeeId = `QA${suffix}`;
    const username = `qauser${suffix}`;
    const password = `StrongPass!${suffix}`;

    let baselineCount = -1;

    // 1. Setup / baseline: Navigate to PIM > Employee List with no search filters applied,
    // and note the baseline total from the '(N) Records Found' text.
    await test.step("Setup / baseline: Navigate to PIM > Employee List with no search filters applied, and note the baseline total from the '(N) Records Found' text", async () => {
      await page.goto('/web/index.php/pim/viewEmployeeList');
      const recordsFound = page.getByText(/\(\d+\) Records? Found/);
      await expect(recordsFound).toBeVisible();
      const text = await recordsFound.textContent();
      const match = text?.match(/\((\d+)\)/);
      expect(match).not.toBeNull();
      baselineCount = parseInt(match![1], 10);
    });

    // 2. Navigate to PIM > Add Employee.
    await test.step('Navigate to PIM > Add Employee', async () => {
      await page.goto('/web/index.php/pim/addEmployee');
      await expect(page.getByRole('heading', { name: 'Add Employee' })).toBeVisible();
    });

    // FRAGILE: Employee Id input has no accessible name/placeholder/label, verified live.
    const employeeIdInput = page.locator('.oxd-input-group').filter({ hasText: /^Employee Id$/ }).locator('input');

    // 3. Generate unique test data for this run. Fill First Name and Last Name with the
    // unique values.
    await test.step('Generate unique test data for this run and fill First Name and Last Name with the unique values', async () => {
      await page.getByPlaceholder('First Name').fill(firstName);
      await page.getByPlaceholder('Last Name').fill(lastName);
      // The auto-generated Employee Id is present as soon as the page loads and does not
      // change in response to typing the name (clarification, not a mismatch) — just
      // confirm it is present.
      await expect(employeeIdInput).not.toHaveValue('');
    });

    // 4. Edit the Employee Id field to a unique custom value.
    await test.step('Edit the Employee Id field to a unique custom value', async () => {
      await employeeIdInput.fill(employeeId);
      await expect(employeeIdInput).toHaveValue(employeeId);
    });

    // 5. Toggle on 'Create Login Details'.
    await test.step("Toggle on 'Create Login Details'", async () => {
      // FRAGILE: the underlying <input type="checkbox"> has no accessible name and is
      // pointer-intercepted by its sibling <span class="oxd-switch-input"> — clicking the
      // input directly hangs until the action timeout, verified live. Click the span.
      await page.locator('.oxd-switch-input').first().click();
      await expect(page.getByRole('radio', { name: 'Enabled' })).toBeChecked();
    });

    // FRAGILE: Username/Password/Confirm Password inputs have no accessible
    // name/placeholder/label; the ^...$ anchors are required because "Confirm Password"
    // also contains the substring "Password", verified live.
    const usernameInput = page.locator('.oxd-input-group').filter({ hasText: /^Username$/ }).locator('input');
    const passwordInput = page.locator('.oxd-input-group').filter({ hasText: /^Password$/ }).locator('input');
    const confirmPasswordInput = page.locator('.oxd-input-group').filter({ hasText: /^Confirm Password$/ }).locator('input');

    // 6. Fill Username with a unique value. Fill Password and Confirm Password with a
    // matching strong password. Leave the Status radio on 'Enabled'.
    await test.step("Fill Username with a unique value, fill Password and Confirm Password with a matching strong password, and leave Status on 'Enabled'", async () => {
      await usernameInput.fill(username);
      await passwordInput.fill(password);
      await confirmPasswordInput.fill(password);
      await expect(page.getByText('Strongest')).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Enabled' })).toBeChecked();
    });

    // 7. Click the 'Save' button.
    await test.step("Click the 'Save' button", async () => {
      await page.getByRole('button', { name: 'Save' }).click();
      // The save round-trip is slow: the app can stay on /addEmployee for several
      // seconds before the client-side route change to viewPersonalDetails begins,
      // so this navigation assertion needs more than the 5s default (timing only).
      await expect(page).toHaveURL(/\/pim\/viewPersonalDetails\/empNumber\/\d+/, { timeout: 30000 });
      await expect(page.getByRole('heading', { name: `${firstName} ${lastName}` })).toBeVisible();
      await expect(employeeIdInput).toHaveValue(employeeId);
    });

    // 8. Navigate to PIM > Employee List. In the Employee Name search field, type the
    // unique first+last name, wait for and click the matching suggestion in the
    // autocomplete dropdown, then click 'Search'.
    await test.step("Navigate to PIM > Employee List, search by the unique employee name via the autocomplete field, and click 'Search'", async () => {
      await page.goto('/web/index.php/pim/viewEmployeeList');
      // FRAGILE: there are two identical 'Type for hints...' autocomplete fields on this
      // page (Employee Name and Supervisor Name), so an unscoped getByPlaceholder is
      // ambiguous, verified live.
      const employeeNameInput = page
        .locator('.oxd-input-group')
        .filter({ hasText: /^Employee Name$/ })
        .getByPlaceholder('Type for hints...');
      await employeeNameInput.fill(`${firstName} ${lastName}`);
      await page.getByRole('option', { name: `${firstName} ${lastName}` }).click();
      await page.getByRole('button', { name: 'Search' }).click();

      // Expect: filters to exactly the new record, "(1) Record Found" (singular wording).
      await expect(page.getByText('(1) Record Found')).toBeVisible();
      const row = page.getByRole('row', { name: new RegExp(employeeId) });
      await expect(row).toBeVisible();
      await expect(row).toContainText(firstName);
      await expect(row).toContainText(lastName);
      await expect(row.getByRole('cell').nth(1)).toHaveText(employeeId);
      // CLARIFICATION (not a mismatch): the Employment Status column is blank for an
      // employee created with only Personal Details and no Job tab entry — do not assert
      // a specific Employment Status text here.
    });

    // 9. Navigate to Admin > User Management > Users, fill the Username filter with the
    // unique username created earlier, and click 'Search'.
    await test.step("Navigate to Admin > User Management > Users, filter by the unique username, and click 'Search' to verify the login's Enabled status", async () => {
      await page.goto('/web/index.php/admin/viewSystemUsers');
      // FRAGILE: Username filter input has no accessible name/placeholder, verified live.
      const usernameFilter = page.locator('.oxd-input-group').filter({ hasText: /^Username$/ }).locator('input');
      await usernameFilter.fill(username);
      await page.getByRole('button', { name: 'Search' }).click();

      // This shared public demo shows highly variable response times under concurrent
      // load from other test runs (observed live: total run time for this spec varied from
      // ~18s to ~38s across consecutive runs), so the default 5s assertion timeout is
      // sometimes too tight for this search round-trip (timing only, not a locator/assertion
      // change — still requires the exact singular "(1) Record Found" wording).
      await expect(page.getByText('(1) Record Found')).toBeVisible({ timeout: 20000 });
      const userRow = page.getByRole('row', { name: new RegExp(username) });
      await expect(userRow).toContainText('ESS');
      await expect(userRow).toContainText(`${firstName} ${lastName}`);
      await expect(userRow).toContainText('Enabled');
    });

    // 10. Return to PIM > Employee List with no search filters applied. In the 'Id' column
    // header, click the sort icon to open its Ascending/Descending menu, then click
    // 'Ascending' scoped to that same header.
    await test.step("Return to PIM > Employee List, sort the 'Id' column ascending, and verify the new employee's Id is in the correct position", async () => {
      await page.goto('/web/index.php/pim/viewEmployeeList');
      // FRAGILE: scoped to the Id header — every column header renders its own hidden
      // Ascending/Descending menu in the DOM, so an unscoped getByText('Ascending')
      // resolves to 7 elements, verified live.
      const idHeader = page.locator('.oxd-table-header-cell', { hasText: 'Id' }).first();
      await idHeader.locator('.oxd-icon').first().click();
      await idHeader.getByText('Ascending', { exact: true }).click();

      // The sort is lexicographic/string-based, not numeric (clarification, not a
      // mismatch). Rather than asserting a fixed absolute index (which would be brittle
      // against this shared demo's ever-changing dataset), collect the Id column across
      // every pagination page and confirm the new employee's Id sits correctly between its
      // immediate ascending-order neighbors. Wrapped in expect.toPass() to tolerate the
      // brief re-render after the sort click, not an arbitrary wait.
      //
      // FIXED (was flaky): the previous implementation captured `pagination.getByRole('button')`
      // once and then drove the sweep with `.nth(i)` on that live locator. The pagination
      // component only renders a "previous" arrow when NOT on page 1, and only a "next" arrow
      // when NOT on the last page (confirmed live via the rendered HTML), so the button count
      // and index-to-page mapping shifts after every click. Reproduced live: starting the sweep
      // from a non-first page caused index 2 to resolve to page 3 instead of page 2, permanently
      // skipping page 2 on every retry and spinning until the 120s test timeout. Fixed by always
      // returning to page 1 by its own accessible name first, then walking forward one page at a
      // time via the "Next" arrow (identified by its chevron icon, since it has no accessible
      // name) until it disappears — immune to index shifting because it never uses `.nth()` on
      // the pagination control.
      await expect(async () => {
        const pagination = page.getByRole('navigation', { name: 'Pagination Navigation' });
        const bodyRows = page.getByRole('row').filter({ has: page.getByRole('cell') });
        await expect(bodyRows.first()).toBeVisible({ timeout: 45_000 });

        // FIXED (was broken on a small dataset): OrangeHRM doesn't render a "Pagination
        // Navigation" control at all when every record already fits on one page — confirmed
        // live against a small self-hosted instance (a handful of employees), as opposed to
        // the large shared public demo this was originally verified against (96+ employees,
        // always paginated). Only drive the pagination sweep when a pagination control
        // actually exists; otherwise the single visible page already has every row.
        const hasPagination = (await pagination.count()) > 0;

        const allIds: string[] = [];
        if (!hasPagination) {
          const rowCount = await bodyRows.count();
          for (let r = 0; r < rowCount; r++) {
            const idText = await bodyRows.nth(r).getByRole('cell').nth(1).textContent();
            allIds.push((idText ?? '').trim());
          }
        } else {
          // This shared demo's pagination control can take longer than the global 30s
          // actionTimeout to re-render after the sort click, especially under concurrent load
          // from other test runs (same variability documented on step 9 above). Waiting for the
          // control to actually be visible first — with a longer explicit timeout — means a slow
          // render fails fast on this wait instead of burning the whole click's timeout budget
          // (and therefore most of the 120s test timeout) stuck on one toPass() iteration
          // (timing only, not a locator/behavior change).
          await expect(pagination).toBeVisible({ timeout: 45_000 });

          // Always start from page 1 via its own numeric label, not a positional index — this
          // works whether we're already on page 1 or a retry left us on a later page.
          await pagination.getByRole('button', { name: '1', exact: true }).click({ timeout: 45_000 });
          await expect(bodyRows.first()).toBeVisible();

          while (true) {
            const rowCount = await bodyRows.count();
            for (let r = 0; r < rowCount; r++) {
              const idText = await bodyRows.nth(r).getByRole('cell').nth(1).textContent();
              allIds.push((idText ?? '').trim());
            }

            // FRAGILE: the "Next" arrow has no accessible name and shares its button class with
            // the "Previous" arrow, so it's identified by its chevron-right icon class, verified
            // live. It is absent entirely on the last page.
            const nextButton = pagination.locator('button:has(.bi-chevron-right)');
            if ((await nextButton.count()) === 0) break;
            // Same slow-render risk as the page-1 click above, so the same explicit timeout
            // (timing only).
            await nextButton.click({ timeout: 45_000 });
            await expect(bodyRows.first()).toBeVisible();
          }
        }

        const idx = allIds.indexOf(employeeId);
        expect(idx).toBeGreaterThan(-1);
        if (idx > 0) {
          expect(allIds[idx - 1].localeCompare(employeeId, undefined, { sensitivity: 'base' })).toBeLessThanOrEqual(0);
        }
        if (idx < allIds.length - 1) {
          expect(allIds[idx + 1].localeCompare(employeeId, undefined, { sensitivity: 'base' })).toBeGreaterThanOrEqual(0);
        }
      }).toPass();
    });

    // 11. With no search filters applied, read the '(N) Records Found' text on the
    // Employee List.
    await test.step("With no search filters applied, read the '(N) Records Found' text on the Employee List and confirm it reflects the new employee's creation", async () => {
      await page.goto('/web/index.php/pim/viewEmployeeList');
      // The '(N) Records Found' total is a GLOBAL, SHARED counter on this public demo —
      // other concurrent test runs create/delete employees against the same counter, so an
      // exact baselineCount + 1 equality is inherently racy (timing/environment, not a
      // business-outcome change). The actual business outcome — that the employee was
      // created and is findable — is already proven by steps 8-10 (name search, Admin user
      // search, and the Id sort sweep). Here, just confirm the total moved forward by at
      // least this creation and never regressed below it.
      const recordsFound = page.getByText(/\(\d+\) Records? Found/);
      await expect(async () => {
        const text = await recordsFound.textContent();
        const match = text?.match(/\((\d+)\)/);
        expect(match).not.toBeNull();
        const currentCount = parseInt(match![1], 10);
        expect(currentCount).toBeGreaterThanOrEqual(baselineCount + 1);
      }).toPass();
    });
  });
});
