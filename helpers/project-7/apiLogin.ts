// Logs in to OrangeHRM's session-cookie-based auth flow using Playwright's `request` fixture
// (no browser/page involved) and leaves the resulting `_orangehrm` session cookie set on the
// SAME `request` context passed in — Playwright's APIRequestContext shares a single cookie jar
// across every call made on it, so every subsequent request.get/post/put/etc. on this context is
// automatically authorized afterwards. Reuse this at the top of any api-engine spec for this
// project instead of re-implementing the CSRF-scrape + form-post dance per file.
//
// Flow (verified live against http://localhost:8080/) — delegated to apiLoginAs.ts's shared
// implementation, this file just supplies the seeded-admin env-var defaults:
//   1. GET /web/index.php/auth/login. If the request context already carries a valid
//      `_orangehrm` session (the `generated` Playwright project applies the shared
//      storageState from tests/auth-setups/project-7.setup.ts to every generated spec,
//      API-engine ones included), this redirects straight to
//      `/web/index.php/dashboard/index` with no login form at all — nothing left to do, so
//      this is a no-op in that case. Otherwise the page renders the CSRF token into the
//      `:token="..."` prop of its `<auth-login>` component (HTML-entity-encoded, e.g.
//      `:token="&quot;<token>&quot;"`) — scrape it out.
//   2. POST /web/index.php/auth/validate as a form submission with `_token`, `username`,
//      `password`. A successful login 302-redirects to `/web/index.php/dashboard/index`
//      (and sets a fresh `_orangehrm` cookie); a failed login 302-redirects back to
//      `/web/index.php/auth/login` instead — both cases return the same 302 status, so success
//      must be detected from the final redirected-to URL, not the status code.
import type { APIRequestContext } from '@playwright/test'
import { apiLoginAs } from './apiLoginAs'

export async function apiLogin(request: APIRequestContext): Promise<void> {
  const username = process.env.TEST_USER_NAME || 'qatooladmin'
  const password = process.env.TEST_USER_PASSWORD || 'QaTool2026!Seed'

  await apiLoginAs(request, username, password)
}
