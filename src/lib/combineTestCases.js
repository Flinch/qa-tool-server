import Anthropic from '@anthropic-ai/sdk'
import { AUTOMATION_GUIDANCE } from './automationGuidance.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Takes 2+ existing test cases that share a similar/overlapping flow and
// returns ONE draft that covers everything they verified, without repeating
// shared setup/navigation for each. Does not touch the database — callers
// own inserting the result and re-pointing requirement/bug links. Platform
// is not decided by the AI: the caller has already validated every input
// test case shares the same platform before this is invoked, since a web
// and a mobile flow have nothing to merge.
export async function combineTestCases(testCases) {
  const list = testCases
    .map(tc => `[id=${tc.id}] Title: ${tc.title}\nType: ${tc.type}\nSteps:\n${(tc.steps || []).map(s => `- ${s}`).join('\n')}\nExpected: ${tc.expected || '(none)'}`)
    .join('\n\n')

  const prompt = `You are a senior QA engineer. The following ${testCases.length} test cases were flagged by an engineer as covering a similar or overlapping flow through the app. Merge them into ONE combined test case that verifies everything the originals verified, without repeating shared navigation/setup more than once (e.g. if two test cases both start by navigating to the same screen, that navigation should appear once in the combined flow, followed by all the assertions/actions from every original test case in a sensible order).

Return ONLY a valid JSON object with no preamble, no markdown, no explanation, with these fields:
- "title": string — clear name for the combined test case
- "type": one of "functional" | "integration" | "e2e" | "api" — if the originals share type "api", the combined test case must stay "api" too
- "steps": array of strings — one action per step, in order, covering every original test case's steps with shared setup deduplicated. Do NOT prefix each string with a number or "Step N:" — the UI renders these in a numbered list already
- "expected": string — the combined expected result, covering every original test case's expectation
${AUTOMATION_GUIDANCE}

Rules:
- Do not drop any real assertion or behavior from any of the originals — combining must not reduce coverage
- If the test cases genuinely don't share enough of a flow to combine sensibly, still produce your best single combined flow (the engineer reviews this before anything is applied) but keep "automationReasoning" honest about the tradeoff

Test cases to combine:
${list}`

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = message.content[0].text.trim()
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch (e) {
    if (message.stop_reason === 'max_tokens') {
      throw new Error('AI response was cut off before completing (too many/too large test cases to combine at once — try fewer).')
    }
    throw e
  }
}
