// Logs in to OrangeHRM's session-cookie-based auth flow (CSRF-scrape from the login page's
// `:token="..."` prop + form-post to /web/index.php/auth/validate) for an ARBITRARY username/
// password on the given `request` context's own cookie jar — same dance `apiLogin.ts` uses for
// the seeded admin env creds, factored out here so a second identity (e.g. the seeded ESS login
// `baselinemanager` / `QaTool2026!Manager`, needed whenever a test requires a distinct
// employee-vs-approver pair) doesn't have to re-implement it. Reuse this any time an api-engine
// spec needs to authenticate as a specific non-default user on its own `APIRequestContext`.
import type { APIRequestContext } from '@playwright/test'

const TOKEN_PROP_REGEX = /:token="&quot;([^&]*)&quot;"/

export async function apiLoginAs(
  request: APIRequestContext,
  username: string,
  password: string
): Promise<void> {
  const loginPageResponse = await request.get('/web/index.php/auth/login')
  if (!loginPageResponse.url().includes('/auth/login')) {
    // Already authenticated (inherited storageState) — redirected straight past the login form.
    return
  }

  const loginPageHtml = await loginPageResponse.text()
  const tokenMatch = loginPageHtml.match(TOKEN_PROP_REGEX)
  if (!tokenMatch) {
    throw new Error('apiLoginAs: could not find the CSRF `token` prop on the OrangeHRM login page')
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
      `apiLoginAs: login failed for user "${username}" — redirected back to the login page`
    )
  }
}
