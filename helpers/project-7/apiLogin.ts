// Logs in to OrangeHRM's session-cookie-based auth flow using Playwright's `request` fixture
// (no browser/page involved) and leaves the resulting `_orangehrm` session cookie set on the
// SAME `request` context passed in — Playwright's APIRequestContext shares a single cookie jar
// across every call made on it, so every subsequent request.get/post/put/etc. on this context is
// automatically authorized afterwards. Reuse this at the top of any api-engine spec for this
// project instead of re-implementing the CSRF-scrape + form-post dance per file.
//
// Flow (verified live against http://localhost:8080/):
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

const TOKEN_PROP_REGEX = /:token="&quot;([^&]*)&quot;"/

export async function apiLogin(request: APIRequestContext): Promise<void> {
  const username = process.env.TEST_USER_NAME || 'qatooladmin'
  const password = process.env.TEST_USER_PASSWORD || 'QaTool2026!Seed'

  const loginPageResponse = await request.get('/web/index.php/auth/login')
  if (!loginPageResponse.url().includes('/auth/login')) {
    // Already authenticated (inherited storageState) — redirected straight past the login form.
    return
  }

  const loginPageHtml = await loginPageResponse.text()
  const tokenMatch = loginPageHtml.match(TOKEN_PROP_REGEX)
  if (!tokenMatch) {
    throw new Error('apiLogin: could not find the CSRF `token` prop on the OrangeHRM login page')
  }

  const validateResponse = await request.post('/web/index.php/auth/validate', {
    form: {
      _token: tokenMatch[1],
      username,
      password,
    },
  })

  if (validateResponse.url().includes('/auth/login')) {
    throw new Error(
      `apiLogin: login failed for user "${username}" — redirected back to the login page`
    )
  }
}
