# OrangeHRM self-hosted seed

Replaces the shared public demo (`opensource-demo.orangehrmlive.com`) for project 7's
tests with a private, ephemeral, self-hosted instance — same app, same version
(OrangeHRM Starter 5.9, GPL-3.0), zero shared state with anyone else.

## What's here

- **`seed.sql`** — a `mysqldump` of a freshly-installed OrangeHRM Starter 5.9
  database, with the minimum extra data the existing generated tests
  (TC-62, TC-63, TC-65) already assume exists:
  - One Job Title: `QA Engineer` (a brand-new install ships with **zero** job
    titles — confirmed live, the Job Title dropdown shows "No Records Found"
    otherwise, which breaks vacancy/employee creation immediately).
  - One baseline employee (`Baseline Manager`) so the Hiring Manager
    autocomplete has at least one real employee to suggest — a fresh install
    has zero employees, so an empty autocomplete never resolves and the
    field never gets a value (the exact "hardcoded 'Daisy' doesn't resolve"
    failure class, just with *nothing* instead of a stale name).
  - The admin login: username `qatooladmin`, password `QaTool2026!Seed` —
    fixed and known, not something that can drift or be changed via the
    frontend by someone unaware it will break CI.
  - A defined Leave Period (calendar year, Jan 1 – Dec 31) — a fresh install
    has **no** leave period configured at all, which makes every leave
    endpoint (`/leave/leave-periods`, Add Leave Entitlement, Apply for
    Leave) either 500 or show "No Records Found"/"Leave Period Start Date
    Is Not Defined." Confirmed live: this cost a real generation run (TC-64)
    its entire time budget rebuilding this from scratch.
  - Two Leave Types: `QA Annual Leave` and `QA Unpaid Leave` — a fresh
    install ships with zero leave types, so "apply for leave" and any
    leave-type dropdown has nothing to select.
  - A 20-day `QA Annual Leave` entitlement for the current leave period,
    assigned to every seeded employee (`QA Admin`, `Baseline Manager`) —
    without this, an employee can select the leave type but the balance is
    0 and the application is rejected. Added via "Add Leave Entitlement" →
    "Multiple Employees" (no Location/Sub Unit filter matches everyone) to
    sidestep the "Individual Employee" autocomplete, which is unreliable
    under browser automation (typed text truncates, suggestion clicks don't
    commit).
  - A second login, `baselinemanager` / `QaTool2026!Manager` (ESS role,
    tied to the `Baseline Manager` employee), plus a Direct supervisor
    relationship with `QA Admin` as the supervisor (Admin > User Management
    for the login, PIM > Baseline Manager > Report-to > Assigned Supervisors
    for the relationship). Needed for any "employee submits a leave request,
    a different authorised approver approves it" flow — confirmed live that
    OrangeHRM blocks self-approval regardless of role (a logged-in Admin's
    own pending leave never appears in their own "My Actions" widget or as
    an Approve/Reject action on their own request in Leave List). With only
    one seeded login, a generation run has no way to exercise the approval
    step at all and would otherwise have to build a second user + supervisor
    link from scratch live, exactly the kind of setup cost this seed exists
    to avoid. Verified end-to-end: `baselinemanager` applies for
    `QA Annual Leave` → shows up as "(1) Leave Request to Approve" in
    `qatooladmin`'s My Actions → Approve is available and updates the leave
    balance correctly.
  - `hs_hr_config`'s `timesheet_period_set` flipped to `Yes` — a fresh
    install has this at `No`, which blocks the ENTIRE Time module's API
    with a blanket `403 Forbidden` on every route (`/api/v2/time/*`) for
    every role, including Admin — not a permissions issue, the module
    simply refuses to serve anything until a timesheet period (first day
    of week) is defined once via Time > Timesheets > "Define Timesheet
    Period". Confirmed live: this cost a real API-test generation run (TC-72,
    2026-08-05) its entire planner batch — the live-verifying planner agent
    got 403 on every `/api/v2/time/*` endpoint with both `qatooladmin` and
    `baselinemanager` and (reasonably, given the evidence available to it)
    concluded it was a missing employee-role credential, when the real
    cause was this one unset flag. Same class of gap as the Leave Period
    fix above, just for Time instead of Leave. Verified end-to-end on a
    fresh container built from this exact seed: `GET
    /api/v2/time/timesheets` returns `200 {"data":[],...}` immediately,
    zero manual setup, for both `qatooladmin` and `baselinemanager`.
- **`Conf.php`** — the app-level DB connection config
  (`lib/confs/Conf.php` inside the `orangehrm/orangehrm` image), captured
  from a real install. It's a plain PHP class hardcoding `dbHost=db`,
  `dbName=orangehrm`, `dbUser=orangehrm`, `dbPass=orangehrm123` — pairing it
  with `seed.sql` (dumped from a database using those exact same
  credentials) is what lets a brand new `orangehrm/orangehrm` container skip
  the interactive web installer entirely and boot straight to a working
  login.

## Why two files instead of a custom baked image

The original plan was to build and push a custom Docker image with the seed
baked in. Turned out unnecessary: `orangehrm/orangehrm:5.9` (official image)
+ `mariadb:10.4` (official image) + these two small files, mounted at
container start, reproduces the exact same result with zero image-build step
and no registry to maintain. Verified locally end-to-end: fresh containers,
these two files mounted, straight to a working `qatooladmin` login with no
installer interaction.

## Regenerating the seed

If a test needs more baseline data later (another job title, another
employee, a pre-existing vacancy, etc.), add it through the OrangeHRM UI
against a running instance, then re-dump:

```bash
docker exec <db-container> mysqldump -u root -p<root-password> orangehrm \
  --no-tablespaces > seed.sql
```

`Conf.php` only needs regenerating if the DB host/name/user/pass choices
change — it's `docker exec <web-container> cat /var/www/html/lib/confs/Conf.php`.

## Using it

GitHub Actions' `services:` containers boot *before* `actions/checkout`, so
they can't reference a file mount from a checkout that hasn't happened yet.
These two files are instead mounted by explicit `docker run` steps *after*
checkout, on a small user-defined network so the `web` container can resolve
the hostname `db` (matching what `Conf.php` expects) — see
`.github/workflows/playwright-orangehrm.yml` for the working pattern.
