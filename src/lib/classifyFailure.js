// Distinguishes an environmental/infra failure (the test never really ran —
// a device, driver, or connectivity problem) from a genuine assertion
// failure, by pattern-matching the raw CI error message. Conservative on
// purpose: only tags environmental when the message clearly matches a known
// infra signature — misclassifying a real bug as "environmental" would get
// it dismissed instead of fixed, which is worse than under-tagging.
//
// Patterns below are real signatures hit during the iOS Maestro
// driver-instability investigation (Phase 8), not guesses:
// "Device became unreachable during ...", "Package ... is not installed",
// "Failed to connect to /127.0.0.1:<port>", plus report-mobile-results.js's
// own "no device connected" message for a run with no results file at all.
const ENVIRONMENTAL_PATTERNS = [
  /unreachable/i,
  /is not installed/i,
  /failed to connect/i,
  /connection refused/i,
  /no device connected/i,
  /device not found/i,
]

export function classifyFailure(errorMessage) {
  if (!errorMessage) return false
  return ENVIRONMENTAL_PATTERNS.some(p => p.test(errorMessage))
}
