# TC-65: Add candidate for a vacancy and progress through the hiring workflow to hired

<!-- source: qa-tool test case 65 | type: e2e -->
<!-- automation rationale: Adding a candidate and driving them through the full recruitment pipeline to hired is the complete end-to-end journey of the Recruitment module and validates every critical recruiting requirement. -->

<!-- planner note: per repo convention (AGENTS.md), generated tests for this project start
     already authenticated via storageState (tests/auth-setups/project-7.setup.ts) — the
     original step 1 wording ("Log in as an HR admin and navigate to...") has been corrected
     below to drop the login clause; no login step should be written in the generated test. -->

<!-- planner note: no existing helper in helpers/project-7/ (or the flat helpers/) covers
     Recruitment > Vacancies or Recruitment > Candidates. helpers/project-7/createEmployee.ts
     creates a PIM Employee record — a different module/entity — and is not reusable for this
     flow. This plan's steps are the first exploration of Recruitment for this project; if
     vacancy creation and/or candidate creation prove to be genuinely reusable setup actions
     while generating, extract them into new helpers/project-7/ file(s) per AGENTS.md's
     per-project helper convention, the same way createEmployee.ts was extracted for PIM. -->

## Scenario: TC-65 — Add candidate for a vacancy and progress through the hiring workflow to hired

Starting state: authenticated (storageState), on the dashboard.

<!-- planner note: step 1 originally assumed a pre-existing active vacancy. Per AGENTS.md's
     test data policy ("tests create the data they need... must pass twice in a row"),
     depending on shared demo data that may not exist (or may drift) is a flakiness risk —
     if no active vacancy is found live, create one first (Recruitment > Vacancies > Add) with
     a unique job title rather than failing or reusing another test's vacancy. -->

Steps:
1. Navigate to Recruitment > Vacancies and confirm at least one active vacancy exists; if none exists, create one first via Recruitment > Vacancies > Add using a unique job title, so this test does not depend on pre-existing shared demo data
2. Navigate to Recruitment > Candidates > Add Candidate
3. Select the target job vacancy, enter the candidate's full name (unique per run, e.g. a timestamp-derived suffix, so re-running never collides with a previously created candidate), specify the hiring manager, and set the application method
4. Save the candidate record
5. Navigate to the Candidates list and search for the new candidate by name and vacancy to confirm the record appears
6. Sort the candidate list by Date of Application and verify the new candidate appears in the correct position relative to its neighbors
7. Open the candidate record and advance the status to Shortlisted
8. Schedule an interview for the candidate
9. Mark the scheduled interview's outcome as Passed
10. Extend a job offer to the candidate
11. Mark the candidate as Hired and save
12. Return to the Candidates list and verify the candidate's status column reflects Hired

Expect: A candidate is successfully added against a vacancy with hiring manager and application method captured; the candidate is discoverable via filtered and sorted search; the candidate progresses through each workflow stage (shortlisted → interview scheduled → interview passed → job offered → hired) and the final Hired status is correctly reflected in the list.
