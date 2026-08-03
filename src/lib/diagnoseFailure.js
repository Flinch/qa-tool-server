import Anthropic from '@anthropic-ai/sdk'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

// Same fail-open SDK-or-CLI pattern as describeFailure.js: a real
// ANTHROPIC_API_KEY hits the API directly, otherwise falls back to the
// already-authenticated `claude` CLI subprocess (local dev has no real key
// configured — see .env's REPLACE_ME placeholder).
const hasRealApiKey = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('REPLACE_ME')
const anthropic = hasRealApiKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null

function buildPrompt({ testTitle, suiteName, errorMessage, steps, expected, history }) {
  const historyText = history.length > 0
    ? history.map(h => `${h.status}${h.error_message ? ` — ${h.error_message.split('\n')[0].slice(0, 140)}` : ''}`).join('\n')
    : 'No prior runs recorded for this test.'

  return [
    `You are a senior QA engineer explaining why an automated test just failed, so a teammate can decide whether it needs a real code fix or is just noise. Answer the way you'd explain it out loud to a colleague — plain language, no test-framework jargon.`,
    `Test: ${testTitle}`,
    `Suite: ${suiteName}`,
    steps ? `Steps:\n${steps}` : null,
    expected ? `Expected result: ${expected}` : null,
    `Raw failure reported by the test framework:\n${errorMessage}`,
    `Recent run history for this exact test (most recent first):\n${historyText}`,
    `Decide which of these best describes what happened, and explain why in 2-4 plain-language sentences:
- "flaky": the failure looks environmental/infra/timing-related (a slow shared environment, a timeout on something that should eventually succeed, a locator that stopped matching because of unrelated global state) rather than the app actually being broken
- "regression": the test executed its steps as designed and a real assertion caught the app genuinely not doing what's expected — a real bug
- "unclear": not enough signal to tell confidently

Return ONLY valid JSON, no markdown, no preamble: {"verdict": "flaky"|"regression"|"unclear", "summary": "..."}`,
  ].filter(Boolean).join('\n\n')
}

async function diagnoseViaSdk(args) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: buildPrompt(args) }],
  })
  return message.content.find(b => b.type === 'text')?.text?.trim() || ''
}

async function diagnoseViaCli(args) {
  const { stdout } = await execFileAsync(
    'claude',
    ['-p', buildPrompt(args), '--permission-mode', 'dontAsk', '--output-format', 'json'],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }
  )
  const parsed = JSON.parse(stdout)
  if (parsed.is_error) throw new Error(parsed.result || 'claude CLI reported an error')
  return (parsed.result || '').trim()
}

// Explains WHY a specific failed test failed — distinct from the healer
// (which fixes it): environmental/flaky noise that should just be re-run
// as-is, or a genuine regression where the test ran correctly and caught a
// real break in the app. Fails open to a neutral "unclear" verdict rather
// than throwing — this is a quick diagnostic aid, not something that
// should ever block the Diagnose button from showing at least something.
export async function generateFailureDiagnosis(args) {
  try {
    const raw = hasRealApiKey ? await diagnoseViaSdk(args) : await diagnoseViaCli(args)
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      verdict: ['flaky', 'regression', 'unclear'].includes(parsed.verdict) ? parsed.verdict : 'unclear',
      summary: parsed.summary || 'No explanation returned.',
    }
  } catch (e) {
    console.error('generateFailureDiagnosis failed, returning unclear:', e.message)
    return { verdict: 'unclear', summary: `Diagnosis unavailable right now: ${e.message}` }
  }
}
