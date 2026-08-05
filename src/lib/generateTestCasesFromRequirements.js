import Anthropic from '@anthropic-ai/sdk'
import { AUTOMATION_GUIDANCE } from './automationGuidance.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// One batched call covering every requirement passed in, not one call per
// requirement — same cost-amortizing principle already established for the
// planner/generator pipeline. Unlike the old generateTestCasesForRequirements
// (blind insert-only), this DIFFS each requirement's proposed test case set
// against whatever's already linked to it, same "modified/removed/new,
// unmentioned = unchanged" shape requirements.js's own upload/diff endpoint
// and generateCriticalFlows.js already use. Does not touch the database —
// callers own applying the reviewed diff.
//
// `requirements` — each item: { id, title, description, testCases: [{id,
// title, type, steps, expected}] } — testCases is that requirement's
// CURRENTLY linked test cases (empty array for a requirement with none yet).
export async function reviewTestCasesForRequirements(requirements) {
  const list = requirements.map(r => {
    const existing = (r.testCases || []).length > 0
      ? r.testCases.map(tc => {
          const steps = (tc.steps || []).map((s, i) => `    ${i + 1}. ${s}`).join('\n')
          return `  [id=${tc.id}] Title: ${tc.title}\n  Type: ${tc.type}\n  Steps:\n${steps}\n  Expected: ${tc.expected || '(none)'}`
        }).join('\n\n')
      : '  (none tracked yet)'
    return `[requirementId=${r.id}] Title: ${r.title}\nDescription: ${r.description || '(none)'}\nCurrently linked test cases:\n${existing}`
  }).join('\n\n---\n\n')

  const prompt = `You are a senior QA engineer. For each of the following requirements, decide what test case(s) SHOULD exist to verify it right now, and classify the difference against what's currently linked to it.

Requirements (each with its title/description and its currently-linked test cases, if any):
${list}

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. One object per requirement that needs ANY change — omit a requirement entirely if its existing test cases are still accurate as-is. Each object:
{
  "requirementId": 12,
  "modified": [{"id": 45, "title": "...", "type": "functional", "steps": ["...", "..."], "expected": "...", "automationCandidate": false, "automationReasoning": ""}],
  "removed": [46],
  "new": [{"title": "...", "type": "functional", "steps": ["...", "..."], "expected": "...", "automationCandidate": false, "automationReasoning": ""}]
}

Rules:
- "modified": existing test cases (use their real id, from the "Currently linked test cases" list above) whose title/steps/expected should change because the requirement's actual meaning changed. Only include one here if it genuinely needs to change — not for stylistic rewording.
- "removed": ids of existing test cases that no longer verify anything real about this requirement (e.g. the requirement narrowed or a scenario it covered no longer applies).
- "new": genuinely new test cases needed to cover this requirement that aren't already represented by an existing (kept or modified) one. Do not propose a new one that duplicates an existing, still-valid test case.
- Any existing test case not mentioned in "modified" or "removed" is assumed still accurate — do not list it, and do not regenerate requirements that need no change at all (omit them from the array).
- "steps": array of strings, one action per step, in order. Do NOT prefix each string with a number or "Step N:" — the UI renders these in a numbered list already.
- "type": one of "functional" | "integration" | "e2e" | "api". Use "api" when the requirement is actually describing backend/API behavior to verify directly — a specific endpoint, HTTP method, status code, request/response payload shape, or a data contract — rather than something a user observes through the UI. A requirement like "the /api/tickets endpoint returns 201 with the created ticket" is "api"; a requirement like "a user sees a confirmation message after creating a ticket" is not, even though a ticket-creation API call happens underneath it. When genuinely unsure, prefer the UI-observable classification (functional/integration/e2e) — only classify as "api" when the requirement itself is written in terms of the API contract, not the user-facing outcome.
- Aim for 1-2 focused test cases total per requirement (existing + new combined) — the core happy path, plus one edge case only if clearly warranted. No redundant or overlapping tests.
${AUTOMATION_GUIDANCE}`

  // Scales with how many requirements + how much existing test-case content
  // there is to hold in mind, same reasoning as generateCriticalFlows.js's
  // budget — floor keeps small batches at least as generous as the old
  // flat-generation value, capped at the safe ceiling proven elsewhere.
  const existingCount = requirements.reduce((n, r) => n + (r.testCases?.length || 0), 0)
  const maxTokens = Math.min(8192, Math.max(4000, (requirements.length + existingCount) * 400))

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = message.content[0].text.trim()
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    // A truncated response (hit max_tokens mid-JSON) throws a generic
    // "Unexpected end of JSON input" that's useless for debugging from the
    // client side — surface what actually happened instead.
    if (message.stop_reason === 'max_tokens') {
      throw new Error(`AI response was cut off before completing (too many requirements in one batch — try fewer at once, or generate this one individually).`)
    }
    throw e
  }
}
