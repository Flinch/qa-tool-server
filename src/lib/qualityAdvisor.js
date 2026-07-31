import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// AI Quality Advisor (Phase 2.3) — reasons over signals that already exist
// elsewhere in the app (bug hotspots, flaky tests, coverage gaps) to
// produce a short, prioritized list of recommendations. Staff-only,
// full stop: this is the one module the client never sees any form of,
// per the governing AI-visibility rule — not even a summarized version.
// Read-only: never writes anything, same "propose, don't act" posture as
// generateCriticalFlows.js.
export async function generateAdvisorInsights({ project, bugHotspots, flakyTests, uncoveredRequirements, automationCoverage, requirementCoverage }) {
  const projectContext = `${project.name}${project.client_name ? ` (${project.client_name})` : ''}${project.description ? ` — ${project.description}` : ''}`

  const prompt = `You are a senior QA advisor reviewing the current state of a software project's testing and quality signals. Give a short, prioritized list of concrete recommendations for what the team should do next.

Project: ${projectContext}

Signals:
- Automation coverage: ${automationCoverage === null ? 'no data yet' : `${automationCoverage}%`}
- Requirement coverage: ${requirementCoverage === null ? 'no data yet' : `${requirementCoverage}%`}
- Bug hotspots (open bugs by feature): ${bugHotspots.length > 0 ? bugHotspots.map(h => `${h.featureName} (${h.openBugCount})`).join(', ') : 'none'}
- Flaky tests (flipped pass/fail across recent runs): ${flakyTests.length > 0 ? flakyTests.map(t => `${t.test_title} (${t.suite_name}, failed ${t.failed_count}/${t.runs_considered})`).join('; ') : 'none'}
- Requirements with zero test coverage: ${uncoveredRequirements.length > 0 ? uncoveredRequirements.map(r => r.title).join('; ') : 'none'}

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "title": string — short, specific recommendation (e.g. "Stabilize the checkout suite before adding new automation")
- "detail": string — one to two sentences explaining why, grounded in the actual signals above
- "priority": "high", "medium", or "low"

Rules:
- 3-6 recommendations, most important first
- Only recommend something the signals above actually support — do not invent issues that aren't reflected in the data
- If a signal category is empty/clean, do not manufacture a recommendation for it
- Be specific (name the actual feature/test/requirement), not generic advice`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = message.content[0].text.trim()
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
  const parsed = JSON.parse(cleaned)

  return parsed
    .filter(r => r.title && r.detail)
    .map(r => ({
      title: r.title,
      detail: r.detail,
      priority: ['high', 'medium', 'low'].includes(r.priority) ? r.priority : 'medium',
    }))
}
