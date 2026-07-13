import Anthropic from '@anthropic-ai/sdk'
import { AUTOMATION_GUIDANCE } from './automationGuidance.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// One batched call covering every requirement passed in, not one call per
// requirement — same cost-amortizing principle already established for the
// planner/generator pipeline (see DECISIONS.md). Returns the parsed array
// with each item tagged by requirementId; does not touch the database —
// callers own inserting into test_cases and linking via
// requirement_test_cases.
export async function generateTestCasesForRequirements(requirements) {
  const list = requirements
    .map(r => `[id=${r.id}] Title: ${r.title}\nDescription: ${r.description || '(none)'}`)
    .join('\n\n')

  const prompt = `You are a senior QA engineer. For each of the following requirements, generate one or more test cases that verify it.

Return ONLY a valid JSON array with no preamble, no markdown, no explanation. Each object must have:
- "requirementId": number — which requirement this test case is for; must match one of the ids given below
- "title": string — clear, specific test case name
- "type": one of "functional" | "integration" | "e2e"
- "steps": array of strings — one action per step, in order. Do NOT prefix each string with a number or "Step N:" — the UI renders these in a numbered list already
- "expected": string — the expected result
${AUTOMATION_GUIDANCE}

Rules:
- Aim for 1-2 focused test cases per requirement — the core happy path, plus one edge case only if clearly warranted
- No redundant or overlapping tests
- Every requirement id listed below must have at least one test case

Requirements:
${list}`

  // A flat budget truncates on bulk generation once there are enough
  // requirements — the old (now-removed) freeform endpoint scaled this by
  // mode (2000 for ~4-8 test cases, 4000 for ~12-20). This scales by actual
  // input size instead, since a single call here can cover anywhere from 1
  // to a whole project's worth of uncovered requirements. Floor of 4000
  // keeps the single-requirement path at least as generous as the old
  // proven-working flat value (never a regression there); scales up past
  // that for bulk; capped at 8192, the safe ceiling already proven
  // elsewhere in this app for this model.
  const maxTokens = Math.min(8192, Math.max(4000, requirements.length * 900))

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
