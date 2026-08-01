// Resolves what a CI job should actually test against for a given project —
// target URL, API base URL, mobile app id, and login credentials.
// project_test_config (per-project, staff-editable — see routes/projects.js's
// test-config endpoints) wins when set; otherwise falls back to the same
// hardcoded env-var defaults every workflow has always used, so a project
// with no config row yet keeps working exactly as before. One resolver, used
// by both GET /generation-payload and GET /run-config in webhooks.js, so the
// fallback chain only lives in one place.

// One app id per mobile platform, not a single shared var — a single
// MOBILE_TARGET_APP_ID silently misdirected generation at whichever
// platform's bundle id happened to be set last (real wasted CI runs from
// this) — moved here unchanged from webhooks.js.
const MOBILE_APP_ID_BY_PLATFORM = {
  android: process.env.MOBILE_TARGET_APP_ID_ANDROID || 'com.sec.android.app.popupcalculator',
  ios: process.env.MOBILE_TARGET_APP_ID_IOS,
}

const DEFAULT_TARGET_URL = 'https://service-desk-roan.vercel.app'

export async function resolveTestEnvironment(db, projectId, platform) {
  const { rows } = await db.query(`SELECT * FROM project_test_config WHERE project_id=$1`, [projectId])
  const config = rows[0] || {}

  const targetUrl = config.target_url || process.env.TARGET_URL || DEFAULT_TARGET_URL
  // Falls back to targetUrl itself, not a separate default — an API suite
  // with no explicit api_base_url assumes the API shares the frontend's
  // origin, same assumption the API-testing phase already committed to.
  const apiBaseUrl = config.api_base_url || targetUrl
  const mobileAppId = platform === 'ios'
    ? (config.mobile_app_id_ios || MOBILE_APP_ID_BY_PLATFORM.ios)
    : platform === 'android'
    ? (config.mobile_app_id_android || MOBILE_APP_ID_BY_PLATFORM.android)
    : null

  // Only a project with its own configured target_url gets a per-project
  // auth-setup file — one that falls back to the shared demo default has no
  // custom login flow to generate, and keeps using tests/auth.setup.ts
  // exactly as before (see authSetupStatus.js for the same "custom target"
  // check used to decide whether the auth-setup gate applies at all).
  const authSetupFile = config.target_url ? `tests/auth-setups/project-${projectId}.setup.ts` : null

  // Same condition as authSetupFile above — a project with no custom target
  // has no app-specific flows to build a helper library for, and keeps
  // using the original flat helpers/*.ts files (createTicket.ts etc.)
  // exactly as before. See AGENTS.md's "Per-project reusable helpers"
  // section for what lives here and when the generator adds to it.
  const helpersDir = config.target_url ? `helpers/project-${projectId}` : null

  return {
    targetUrl,
    apiBaseUrl,
    mobileAppId,
    credentials: config.test_credentials || null,
    authSetupFile,
    helpersDir,
  }
}
