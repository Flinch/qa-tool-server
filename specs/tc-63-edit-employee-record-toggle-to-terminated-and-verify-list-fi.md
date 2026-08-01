# TC-63: Edit employee record, toggle to terminated, and verify list filtering reflects status change

<!-- source: qa-tool test case 63 | type: e2e -->
<!-- automation rationale: Editing, terminating, and deleting employee records represents the full employee lifecycle management journey that administrators perform continuously. -->
<!-- Refined against the live OrangeHRM demo on 2026-08-01. Key corrections from the original draft: (a) the test creates its own employee via Add Employee instead of mutating a pre-existing demo record (test-data policy: never mutate data you didn't create — termination/deletion is destructive); (b) there is NO literal "Terminated" option in the Job tab's "Employment Status" dropdown — that dropdown only holds employment TYPE values (Full-Time Permanent, Part-Time Contract, etc.). Termination is a separate action: a "Terminate Employment" button opens a dialog requiring a Termination Date and a Termination Reason; (c) the past-employee indicator is a "(Past Employee)" suffix on the name/last-name cell, not a literal "Terminated" value in the Employment Status column. This is a mechanism/locator refinement, not a functional contradiction — the overall Expect outcome held end-to-end on live verification, so no BEHAVIOR MISMATCH is flagged. -->

## Scenario: TC-63 — Edit employee record, toggle to terminated, and verify list filtering reflects status change

Starting state: authenticated (storageState), on the dashboard.

Steps:
1. Navigate to PIM > Add Employee and create a new employee with a unique first and last name (via createTestData). Click Save.
   Expect: The employee is saved — a "Successfully Saved" toast appears and the browser navigates to the new employee's Personal Details page (URL contains `/pim/viewPersonalDetails/empNumber/<id>`).
2. Open the employee's "Job" tab from their profile.
   Expect: The Job Details form loads with Joined Date, Job Title, Job Category, Sub Unit, Location, and Employment Status fields (all at "-- Select --"), plus a separate "Employee Termination / Activiation" section containing a "Terminate Employment" button.
3. Open the "Job Title" dropdown and select an option, then click the Job Details "Save" button.
   Expect: The Job Title field shows the selected value (no longer "-- Select --") after saving, and a "Successfully Updated" toast appears — confirming an existing field on the record can be edited and saved.
4. In the "Employee Termination / Activiation" section, click "Terminate Employment". In the dialog, fill the required "Termination Date" and select a "Termination Reason" (e.g. "Other"), then click "Save".
   Expect: The termination saves — the employee's name heading gains a "(Past Employee)" suffix, and the section now reads "Terminated on: <date>" with an "Activate Employment" button replacing "Terminate Employment".
5. Navigate to PIM > Employee List. With the default filters (Include = "Current Employees Only"), type the employee's first name into the "Employee Name" field, then click "Search".
   Expect: The terminated employee no longer appears in the default active-employees view — the name autocomplete shows "No Records Found" and the results table shows no matching row.
6. On the filter panel, open the "Include" dropdown, select "Past Employees Only", re-enter the employee's name if needed, and click "Search".
   Expect: The results show "(1) Record Found" and the matching row's Last Name cell displays the last name with a "(Past Employee)" suffix — the app's actual past/terminated indicator (the Employment Status column stays blank; there is no literal "Terminated" value written there).
7. Confirm the filtered result is the correct employee by name (the "Past Employees Only" + name filter returns exactly the one terminated record).
   Expect: Exactly one record is listed and it matches the created employee's name — confirming accurate filtering of the terminated list.
8. Click the delete (trash icon) action on the employee's row, then confirm the "Are you Sure?" dialog with "Yes, Delete".
   Expect: A "Successfully Deleted" toast appears immediately, and the list for the same "Past Employees Only" + name filter now shows "No Records Found" — the record count decremented from 1 to 0.

Expect: An existing employee record can be edited and saved; terminating the employee (via the Terminate Employment dialog) removes them from the default active Employee List and surfaces them under the "Past Employees Only" Include filter with a "(Past Employee)" indicator; filtering the past list by name returns exactly that record; and deleting it removes the record so the filtered count drops from 1 to 0.
