// The one blend formula behind every Quality Score this app shows — the
// project-wide number on GET /:id/health and each per-platform entry in its
// platformScores array. Extracted so the two can never drift apart: pass
// rate (65%) + requirement coverage (35%), a project missing one shouldn't
// have that null drag its score down, then a penalty on top for open
// critical/high bugs and for flaky tests. null only when there's truly
// nothing to measure yet.
//
// Deliberately NOT automation coverage: that's a testing-process metric (how
// efficiently you verify things), not a product-health metric (is the app
// actually working). Weighting it in implied "less automated = less
// healthy," which isn't true.
export function computeQualityScore({ passRate, requirementCoverage, bugsBySeverity, flakyCount }) {
  let qualityScore = null
  const weighted = [
    passRate !== null && { value: passRate, weight: 0.65 },
    requirementCoverage !== null && { value: requirementCoverage, weight: 0.35 },
  ].filter(Boolean)
  if (weighted.length > 0) {
    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0)
    const base = weighted.reduce((sum, w) => sum + w.value * w.weight, 0) / totalWeight
    const bugPenalty = Math.min(40, bugsBySeverity.critical * 15) + Math.min(25, bugsBySeverity.high * 6)
    const flakePenalty = Math.min(15, flakyCount * 3)
    qualityScore = Math.max(0, Math.min(100, Math.round(base - bugPenalty - flakePenalty)))
  }

  let healthStatus
  if (qualityScore === null) {
    healthStatus = 'insufficient_data'
  } else if (bugsBySeverity.critical > 0 || qualityScore < 70) {
    healthStatus = 'needs_attention'
  } else if (bugsBySeverity.high > 0 || qualityScore < 90) {
    healthStatus = 'good'
  } else {
    healthStatus = 'excellent'
  }

  return { qualityScore, healthStatus }
}
