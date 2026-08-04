// spec: specs/tc-64-employee-submits-a-leave-request-and-authorised-approver-app.md
// seed: tests/seed.spec.ts

import { test, expect, Locator } from '@playwright/test';
import { loginAs } from '../../../helpers/project-7/loginAs';

test.describe('TC-64 — Employee submits a leave request and authorised approver approves it with balance update', () => {
  test('TC-64: Employee submits a leave request and authorised approver approves it with balance update', async ({ page }) => {
    // Two log-out/log-in cycles between two distinct identities plus several navigations, so give
    // this more headroom than the default 30s (timing only).
    test.setTimeout(120_000);

    // Unique date range per run so re-running this test twice in a row never collides with a
    // leave request the previous run already created for the same dates (OrangeHRM rejects an
    // overlapping request). Offset kept small (5-34 days out) so it reliably stays inside the
    // same calendar-year leave period (Jan 1 - Dec 31) regardless of which day the suite runs on.
    const offsetDays = 5 + (Date.now() % 30);
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() + offsetDays);
    const toDate = new Date(fromDate);
    toDate.setDate(fromDate.getDate() + 1);

    function fmt(d: Date): string {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const fromDateStr = fmt(fromDate);
    const toDateStr = fmt(toDate);
    const comment = `TC-64 automated leave request ${Date.now()}`;

    let balanceBeforeApply = 0;
    // FIXED (was wrong, not flaky): "fromDate and toDate are consecutive full days" does NOT
    // always mean 2 days deducted — confirmed live that this app's workweek excludes weekend days
    // from the leave-day count, so a range that happens to land on e.g. a Sunday+Monday pair is
    // only 1 chargeable day, not 2 (a real run tripped this: the created row showed "1.00" under
    // "Number of Days", not the assumed 2). Read the app's own reported Number of Days for the
    // request instead of assuming a fixed value, and use that everywhere below.
    let numberOfDaysActual = 0;
    let requestRow: Locator;

    // 1. Log out of the default admin session and log in as the employee, the seeded ESS login
    // baselinemanager / QaTool2026!Manager. Navigate to Leave > Apply.
    await test.step('Log out of the default admin session and log in as the employee, the seeded ESS login baselinemanager / QaTool2026!Manager. Navigate to Leave > Apply.', async () => {
      await loginAs(page, 'baselinemanager', 'QaTool2026!Manager');
      await page.goto('/web/index.php/leave/applyLeave');
      await expect(page.getByRole('heading', { name: 'Apply Leave' })).toBeVisible();
    });

    // 2. On the Apply for Leave form's Leave Type dropdown, verify that only leave types with a
    // remaining positive balance are available for selection — QA Annual Leave (seeded with a
    // 20-day entitlement for this employee) should be selectable.
    await test.step("On the Apply for Leave form's Leave Type dropdown, verify that only leave types with a remaining positive balance are available for selection — QA Annual Leave (seeded with a 20-day entitlement for this employee) should be selectable", async () => {
      // FRAGILE: the Leave Type select has no accessible role/name of its own; scoped by its own
      // <label> text via the oxd-input-group wrapper, same pattern as tc-65's unlabeled selects
      // for this app — confirmed live.
      const leaveTypeGroup = page.locator('.oxd-input-group', { hasText: 'Leave Type' });
      await leaveTypeGroup.locator('.oxd-select-text').click();

      // Expect: only leave types with a positive balance are offered — confirmed live that the
      // seeded `QA Unpaid Leave` (no entitlement) never appears in this dropdown at all, while
      // `QA Annual Leave` (20-day entitlement) does.
      await expect(page.getByRole('option', { name: 'QA Annual Leave' })).toBeVisible();
      await expect(page.getByRole('option', { name: 'QA Unpaid Leave' })).toHaveCount(0);

      // FIXED (was flaky, not a real balance of 0): selecting a Leave Type triggers its own async
      // leave-balance fetch (`/api/v2/leave/leave-balance/leave-type/<id>`); the paragraph renders
      // a "0.00 Day(s)" placeholder until that response resolves. Reading the paragraph's
      // textContent immediately after the click (no wait) can race that fetch — confirmed live via
      // this exact endpoint returning `{ entitled: 20, used: 2, balance: 18 }` while the DOM still
      // showed "0.00 Day(s)" moments earlier. Wait for the real balance response before reading.
      const balanceResponse = page.waitForResponse(
        (resp) => resp.url().includes('/api/v2/leave/leave-balance/leave-type/') && resp.status() === 200
      );
      await page.getByRole('option', { name: 'QA Annual Leave' }).click();
      await balanceResponse;

      // Capture the balance BEFORE submitting, so the final decrement assertion is relative to
      // whatever this run's actual starting balance is (robust to a persistent instance that
      // hasn't been reset back to the seeded 20 days by a prior run), not a hardcoded 20.
      const balanceParagraph = page.locator('.oxd-input-group', { hasText: 'Leave Balance' }).locator('p');
      await expect(balanceParagraph).not.toHaveText('0.00 Day(s)', { timeout: 10000 });
      const balanceText = await balanceParagraph.textContent();
      balanceBeforeApply = parseFloat(balanceText ?? '0');
      expect(balanceBeforeApply).toBeGreaterThan(0);
    });

    // 3. Select QA Annual Leave, choose a date range within the current leave period (calendar
    // year, Jan 1 – Dec 31), add a comment, and submit the leave request.
    await test.step('Select QA Annual Leave, choose a date range within the current leave period (calendar year, Jan 1 – Dec 31), add a comment, and submit the leave request', async () => {
      const fromDateInput = page.getByRole('textbox', { name: 'yyyy-mm-dd' }).first();
      const toDateInput = page.getByRole('textbox', { name: 'yyyy-mm-dd' }).nth(1);
      await fromDateInput.fill(fromDateStr);
      // FIXED (was broken): filling the To Date field immediately after the From Date field
      // appended to whatever the date-range widget had already auto-populated there instead of
      // replacing it (confirmed live: value became a concatenation of both dates, tripped a
      // "Should be a valid date" error) — clear it first.
      await toDateInput.clear();
      await toDateInput.fill(toDateStr);

      // Filling the comment also blurs the To Date field and closes its calendar popup — both
      // confirmed live to happen as a side effect of this action, so no separate close step is
      // needed.
      await page.locator('textarea').fill(comment);

      await page.getByRole('button', { name: 'Apply' }).click();

      // Expect: the form resets to a blank state, confirming the request was submitted.
      await expect(page.locator('.oxd-input-group', { hasText: 'Leave Type' }).locator('.oxd-select-text')).toHaveText('-- Select --');

      await page.goto('/web/index.php/leave/viewMyLeaveList');
      const row = page.getByRole('row', { name: new RegExp(`${fromDateStr} to ${toDateStr}.*Baseline Manager.*QA Annual Leave`) });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Pending Approval');

      // Read the app's own reported Number of Days for this specific request (see the
      // numberOfDaysActual comment above) rather than assuming a fixed 2, then cross-check that
      // the same row's Leave Balance column reflects the true starting balance minus exactly that
      // many days — this still verifies the real business outcome (the balance actually decreased
      // by the number of days the request consumed), just without the weekend-count assumption.
      // Cell order confirmed live: [checkbox, Date, Employee Name, Leave Type, Leave Balance
      // (Days), Number of Days, Status, Comments, Actions] — Number of Days is index 5.
      const numberOfDaysText = (await row.getByRole('cell').nth(5).textContent())?.trim() ?? '0';
      numberOfDaysActual = parseFloat(numberOfDaysText);
      expect(numberOfDaysActual).toBeGreaterThan(0);
      const expectedBalanceAfterApply = (balanceBeforeApply - numberOfDaysActual).toFixed(2);
      await expect(row).toContainText(expectedBalanceAfterApply);
    });

    // 4. Log out and log in as the authorised approver — the seeded admin login qatooladmin /
    // QaTool2026!Seed ("QA Admin"), the seeded direct supervisor of baselinemanager.
    await test.step('Log out and log in as the authorised approver — the seeded admin login qatooladmin / QaTool2026!Seed ("QA Admin"), the seeded direct supervisor of baselinemanager', async () => {
      await loginAs(page, 'qatooladmin', 'QaTool2026!Seed');
    });

    // 5. Navigate to the approver's leave-approval view (the Dashboard "My Actions" widget, or
    // Leave > Leave List filtered by Pending Approval status) and locate the request submitted by
    // baselinemanager.
    await test.step("Navigate to the approver's leave-approval view (the Dashboard My Actions widget) and locate the request submitted by baselinemanager", async () => {
      await page.goto('/web/index.php/dashboard/index');
      // Verified live: baselinemanager's request appears here as part of the "My Actions" widget's
      // "(N) Leave Request(s) to Approve" count, because qatooladmin is seeded as baselinemanager's
      // direct supervisor. FIXED (was flaky): hardcoding "(1)" assumes this is the only pending
      // request on the whole (shared, persistent) instance — confirmed live it can legitimately be
      // more than 1 if other requests are still outstanding. Match any count instead; the specific
      // request is re-identified by date+employee in the next step regardless of how many others
      // are also pending. Clicking it lands directly on the Leave List already filtered to Pending
      // Approval status.
      const myActionsWidget = page.getByText(/\(\d+\) Leave Requests? to Approve/);
      await expect(myActionsWidget).toBeVisible();
      await myActionsWidget.click();
      await expect(page.getByRole('heading', { name: 'Leave List' })).toBeVisible();
    });

    // 6. Verify the request appears in that view, identified by the employee's name.
    await test.step("Verify the request appears in that view, identified by the employee's name", async () => {
      requestRow = page.getByRole('row', { name: new RegExp(`${fromDateStr} to ${toDateStr}.*Baseline Manager`) });
      await expect(requestRow).toBeVisible();
      await expect(requestRow).toContainText('Baseline Manager');
      await expect(requestRow).toContainText('Pending Approval');
    });

    // 7. Open the request and approve it.
    await test.step('Open the request and approve it', async () => {
      await requestRow.getByRole('button', { name: 'Approve' }).click();
    });

    // 8. Verify the leave request's status transitions to Approved.
    await test.step("Verify the leave request's status transitions to Approved", async () => {
      // CLARIFICATION (not a mismatch): confirmed live that this self-hosted OrangeHRM 5.9 has no
      // literal "Approved" status label — once approved, a future-dated request's status becomes
      // "Scheduled" (a past/current one becomes "Taken"). This is the app's own real terminology
      // for an approved-and-confirmed leave, not a functional contradiction. Confirmed both halves
      // live: approving made the request disappear from this same still-Pending-Approval-filtered
      // list (below), and re-filtering by Scheduled status shows it there instead — i.e. actually
      // approved, just under this app's real label for that state.
      // FIXED (was flaky): asserting the WHOLE Pending-Approval-filtered list is empty assumes
      // this run's request is the only pending one on this shared, persistent instance — confirmed
      // live that isn't reliable (other still-outstanding pending requests, from other runs/dates,
      // can legitimately remain). Check specifically that THIS run's own request (identified by
      // its unique date range + employee, same regex used to find it above) is gone from the
      // still-Pending-Approval-filtered view instead of asserting the entire list is empty.
      const stillPendingRow = page.getByRole('row', { name: new RegExp(`${fromDateStr} to ${toDateStr}.*Baseline Manager`) });
      await expect(stillPendingRow).toHaveCount(0);

      const statusGroup = page.locator('.oxd-input-group', { hasText: 'Show Leave with Status' });
      await statusGroup.locator('.oxd-select-text').click();
      await page.getByRole('option', { name: 'Scheduled' }).click();
      await page.getByRole('button', { name: 'Search' }).click();

      const approvedRow = page.getByRole('row', { name: new RegExp(`${fromDateStr} to ${toDateStr}.*Baseline Manager`) });
      await expect(approvedRow).toBeVisible();
      await expect(approvedRow).toContainText('Scheduled');
    });

    // 9. Log out and log in again as the employee (baselinemanager / QaTool2026!Manager).
    await test.step('Log out and log in again as the employee (baselinemanager / QaTool2026!Manager)', async () => {
      await loginAs(page, 'baselinemanager', 'QaTool2026!Manager');
    });

    // 10. Navigate to Leave > My Leave and verify the request shows Approved status.
    await test.step('Navigate to Leave > My Leave and verify the request shows Approved status', async () => {
      await page.goto('/web/index.php/leave/viewMyLeaveList');
      // See the CLARIFICATION comment in step 8: this app's real label for an approved,
      // future-dated leave is "Scheduled", not literally "Approved".
      const myRow = page.getByRole('row', { name: new RegExp(`${fromDateStr} to ${toDateStr}.*Baseline Manager`) });
      await expect(myRow).toBeVisible();
      await expect(myRow).toContainText('Scheduled');
    });

    // 11. Navigate to the employee's own leave balance view (e.g. Leave > My Leave Balance, or
    // Entitlements) and verify the remaining balance for QA Annual Leave has decreased by the
    // exact number of days taken (starting entitlement was 20 days).
    await test.step("Navigate to the employee's own leave balance view and verify the remaining balance for QA Annual Leave has decreased by the exact number of days taken", async () => {
      // CLARIFICATION (not a mismatch): confirmed live that Leave > Entitlements ("My
      // Entitlements") only ever shows the gross entitlement granted (20 days, unchanged by
      // approvals) — it is not the remaining-balance view. The Apply Leave form's own "Leave
      // Balance" field is the verified live source of the actual remaining balance (it already
      // showed the post-submission balance in steps 2/3), so that is used here instead.
      await page.goto('/web/index.php/leave/applyLeave');
      const leaveTypeGroup = page.locator('.oxd-input-group', { hasText: 'Leave Type' });
      await leaveTypeGroup.locator('.oxd-select-text').click();
      await page.getByRole('option', { name: 'QA Annual Leave' }).click();

      const expectedRemainingBalance = (balanceBeforeApply - numberOfDaysActual).toFixed(2);
      const balanceParagraph = page.locator('.oxd-input-group', { hasText: 'Leave Balance' }).locator('p');
      await expect(balanceParagraph).toHaveText(`${expectedRemainingBalance} Day(s)`);
    });
  });
});
