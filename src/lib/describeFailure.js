import Anthropic from '@anthropic-ai/sdk'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'

const execFileAsync = promisify(execFile)

// Fail-open by design, same idiom as jiraClient.js: a missing key or a flaky
// call must never block a bug from being filed — both paths below fall back
// to the raw error_message when they return null.
const hasRealApiKey = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('REPLACE_ME')
const anthropic = hasRealApiKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null

const PROMPT_INSTRUCTIONS = `Write a short, plain-language description (2-4 sentences) of what actually happened, in the voice of a QA analyst explaining a bug to a developer so they can reproduce it. Describe the observed UI behavior concretely and specifically (what changed, what didn't update, what appeared instead). Do not use test-framework or assertion language — no "assertion", "selector", "element", resource ids, or test-tool jargon.`

function buildPromptText({ scenarioTitle, steps, expected, errorMessage, imagePath }) {
  return [
    `A QA test named "${scenarioTitle}" failed.`,
    steps ? `Steps performed:\n${steps}` : null,
    expected ? `Expected result:\n${expected}` : null,
    `Raw technical failure reported by the test tool:\n${errorMessage}`,
    imagePath
      ? `A screenshot taken at the moment of failure is saved at: ${imagePath} — view it and ground your description in what it actually shows.`
      : null,
    PROMPT_INSTRUCTIONS,
  ].filter(Boolean).join('\n\n')
}

// Direct API call — used whenever a real ANTHROPIC_API_KEY is configured
// (this is how generateTestCasesFromRequirements.js etc. already call
// Claude from the server). Works in any environment, no CLI install needed.
async function describeViaSdk({ scenarioTitle, steps, expected, errorMessage, screenshotBase64 }) {
  const content = [{ type: 'text', text: buildPromptText({ scenarioTitle, steps, expected, errorMessage }) }]
  if (screenshotBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } })
  }
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{ role: 'user', content }],
  })
  return msg.content.find(b => b.type === 'text')?.text?.trim() || null
}

// Subprocess call to the `claude` CLI — used when no API key is configured
// (e.g. local dev, where the CLI is already logged in via OAuth the same
// way the planner/generator/healer agents already invoke it as `claude -p`
// subprocesses). Needs --add-dir to grant Read access to the screenshot,
// since it lives outside the CLI's default trusted workspace.
async function describeViaCli({ scenarioTitle, steps, expected, errorMessage, screenshotBase64 }) {
  let imagePath = null
  try {
    if (screenshotBase64) {
      imagePath = path.join(os.tmpdir(), `bug-screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
      fs.writeFileSync(imagePath, Buffer.from(screenshotBase64, 'base64'))
    }
    const prompt = buildPromptText({ scenarioTitle, steps, expected, errorMessage, imagePath })
    const args = ['-p', prompt, '--permission-mode', 'dontAsk', '--output-format', 'json']
    if (imagePath) args.push('--add-dir', path.dirname(imagePath))

    const { stdout } = await execFileAsync('claude', args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
    const parsed = JSON.parse(stdout)
    if (parsed.is_error) throw new Error(parsed.result || 'claude CLI reported an error')
    return (parsed.result || '').trim() || null
  } finally {
    if (imagePath) fs.rmSync(imagePath, { force: true })
  }
}

// Turns a raw technical test failure into a human-readable bug description.
// Used for both web (Playwright) and mobile (Maestro) failures, since both
// report through the same webhook contract.
export async function describeFailure(args) {
  try {
    if (hasRealApiKey) return await describeViaSdk(args)
    return await describeViaCli(args)
  } catch (e) {
    console.error('describeFailure failed, falling back to raw error message:', e.message)
    return null
  }
}
