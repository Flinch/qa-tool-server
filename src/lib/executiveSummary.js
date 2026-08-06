import Anthropic from '@anthropic-ai/sdk'

// Fail-open by design, same idiom as describeFailure.js/jiraClient.js: this
// feeds the client-facing weekly summary PDF, and a missing key or a flaky
// call must never block the export — the caller falls back to no narrative
// section (the PDF's tables/numbers still work fine on their own) rather
// than failing the whole download over a text-generation hiccup.
const hasRealApiKey = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('REPLACE_ME')
const anthropic = hasRealApiKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null

// Client-facing (confirmed 2026-08-06: an AI-written paragraph is fine here
// as long as it only reasons over signals already shown to the client
// elsewhere on the Dashboard — quality score, pass rate, bug hotspots,
// coverage. This deliberately never sees PR/review-status/generation-backlog
// data, unlike qualityAdvisor.js's staff-only recommendations, which reason
// over exactly that engineering-process-internal signal set and stay
// off-limits to clients under the same governing rule).
export async function generateExecutiveSummary({
  project, healthStatus, qualityScore, passRateThisWeek, passRatePriorWeek,
  bugCountsByStatus, bugCountsBySeverity, bugsOpenedThisWeek, bugsResolvedThisWeek,
  bugHotspots, automationCoverage, requirementCoverage, weekAutomationRuns,
}) {
  if (!hasRealApiKey) return null

  const projectContext = `${project.name}${project.client_name ? ` (${project.client_name})` : ''}`
  const topHotspots = (bugHotspots || [])
    .filter(f => f.openBugCount > 0)
    .sort((a, b) => b.openBugCount - a.openBugCount)
    .slice(0, 3)

  const prompt = `You are writing a short executive summary paragraph for a weekly quality report a QA agency sends to their client's leadership. The reader is a non-technical business/leadership stakeholder, not a QA engineer.

Project: ${projectContext}

Signals:
- Health status: ${healthStatus}, quality score: ${qualityScore ?? 'not enough data yet'}
- Pass rate this week: ${passRateThisWeek !== null ? `${passRateThisWeek}%` : 'no executions this week'}${passRatePriorWeek !== null ? ` (last week: ${passRatePriorWeek}%)` : ''}
- Bugs: ${bugCountsByStatus.open} open, ${bugCountsByStatus.in_progress} in progress, ${bugCountsByStatus.resolved} resolved (all-time). ${bugsOpenedThisWeek} opened this week, ${bugsResolvedThisWeek} resolved this week.
- Currently open, by severity: ${bugCountsBySeverity.critical} critical, ${bugCountsBySeverity.high} high, ${bugCountsBySeverity.medium} medium, ${bugCountsBySeverity.low} low
- Where bugs are concentrated: ${topHotspots.length ? topHotspots.map(f => `${f.featureName} (${f.openBugCount})`).join(', ') : 'no concentration — spread thin or none open'}
- Automated test coverage: ${automationCoverage !== null ? `${automationCoverage}%` : 'no data yet'}
- Requirement coverage: ${requirementCoverage !== null ? `${requirementCoverage}%` : 'no data yet'}
- Automation runs this week: ${weekAutomationRuns.length === 0 ? 'none' : weekAutomationRuns.map(r => `${r.suite_name} ${r.status === 'completed' && r.total > 0 ? `${Math.round((r.passed / r.total) * 100)}%` : r.status}`).join('; ')}

Write 4-6 sentences covering, in this rough order: overall health, the automation pass rate and its direction if there's a prior week to compare, which feature area (if any) has the heaviest concentration of open issues, and a plain release-readiness read. Rules:
- Plain business language — no test-framework or QA jargon (no "assertion", "suite", "flaky", "regression", "test case")
- Only state what the signals above actually support — never invent a cause, a number, or a trend that isn't there
- Frame release readiness as a read/assessment ("looks ready, with X to watch"), never as an unconditional guarantee
- If a signal category is empty/clean, don't manufacture something to say about it
- Write it as flowing prose (a paragraph), not a bulleted list
- Return ONLY the paragraph text, no preamble, no markdown, no heading`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  })

  return message.content.find(b => b.type === 'text')?.text?.trim() || null
}
