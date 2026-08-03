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
