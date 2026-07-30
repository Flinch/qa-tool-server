import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Reasons over the WHOLE active requirement set at once — deliberately not
// per-requirement like generateTestCasesForRequirements.js, since a genuine
// critical flow (register -> browse -> cart -> checkout -> confirm) spans
// multiple requirements and a per-requirement loop structurally can't
// produce that no matter how it's prompted. Returns a diff against the
// currently-tracked flow set (modified/removed/new — unchanged flows are
// implicitly anything not mentioned), same shape as requirements.js's own
// upload/diff endpoint, reviewed by the caller before anything is written.
export async function reviewCriticalFlows({ requirements, existingFlows, project }) {
  const requirementsList = requirements
    .map(r => `[id=${r.id}] Title: ${r.title}\nDescription: ${r.description || '(none)'}`)
    .join('\n\n')

  const existingFlowsList = existingFlows.length > 0
    ? existingFlows.map(f => {
        const steps = (f.steps || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        return `[id=${f.id}] Title: ${f.title}\nSteps:\n${steps}\nExpected: ${f.expected || '(none)'}\nCovers requirement ids: ${f.requirementIds.join(', ') || '(none)'}`
      }).join('\n\n')
    : '(none tracked yet)'

  const projectContext = [
    project.name && `App name: ${project.name}`,
    project.client_name && `Client/company: ${project.client_name}`,
    project.description && `Description: ${project.description}`,
  ].filter(Boolean).join('\n') || '(no project description provided — infer purpose from the requirements alone)'

  const prompt = `You are a senior QA engineer identifying the small set of CRITICAL, end-to-end user journeys that demonstrate this application's core value proposition works, top to bottom. These are the flows worth automating first — not because they're technically easy to script, but because if any one of them breaks, something fundamental about the app is broken.

Project context:
${projectContext}

Active requirements for this project:
${requirementsList}

Existing critical flows already tracked:
${existingFlowsList}

Your job: decide what the RIGHT set of critical flows is right now, and classify the difference against what's already tracked.

A critical flow:
- Represents something a real user would actually do, start to finish — not a synthetic technical path
- Directly demonstrates the app's core value proposition, not a peripheral feature
- Typically spans MULTIPLE requirements/features (e.g. register -> browse -> add to cart -> checkout -> confirm) — a flow confined to a single requirement is rarely a genuine cross-cutting journey, though that's fine if the app is simple enough that a real journey only touches one
- Should be genuinely few in number — most projects need somewhere around 3-8 of these, fewer for a narrow app, more for a large one. Do not pad the list to hit a number, and do not manufacture a flow just to give some requirement coverage it doesn't need

Return ONLY a valid JSON object, no preamble, no markdown, no explanation, with this exact shape:
{
  "modified": [{"id": 12, "title": "...", "steps": ["...", "..."], "expected": "...", "platform": "web", "requirementIds": [3, 7], "reasoning": "..."}],
  "removed": [5, 9],
  "new": [{"title": "...", "steps": ["...", "..."], "expected": "...", "platform": "web", "requirementIds": [1, 4, 8], "reasoning": "..."}]
}

Field notes:
- "steps": array of strings, one action per step, in order. Do NOT prefix each string with a number or "Step N:" — the UI renders these in a numbered list already
- "expected": the single overall expected outcome once the whole flow completes
- "platform": "web" or "mobile" — match whatever the requirements this flow covers are tagged with
- "requirementIds": every requirement id (from the list above) this flow's steps actually exercise — must reference real ids from the list above
- "reasoning": one short sentence on why this is a critical, top-to-bottom flow worth automating first

Rules:
- "modified": existing flows (use their real id) whose steps, expected result, or requirement coverage should change based on the current requirement set. Only include a flow here if something about it genuinely needs to change.
- "removed": ids of existing flows that no longer represent a real critical journey (e.g. the requirements they depended on were removed or fundamentally changed).
- "new": genuinely new critical flows not already covered by an existing one. Do not propose a new flow that duplicates or lightly rewords an existing, still-valid one.
- Any existing flow not mentioned in "modified" or "removed" is assumed still correct as-is — do not list it.
- Do not invent requirement coverage that isn't real — every id in requirementIds must be one of the active requirement ids given above.`

  // Scales with how much context the model has to hold in mind (requirement
  // count + existing flow count), same reasoning as
  // generateTestCasesForRequirements.js's budget — floor keeps small
  // projects at least as generous as that proven-working value, capped at
  // the safe ceiling already established elsewhere in this app.
  const maxTokens = Math.min(8192, Math.max(4000, (requirements.length + existingFlows.length) * 300))

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
    if (message.stop_reason === 'max_tokens') {
      throw new Error(`AI response was cut off before completing (too many requirements/flows to review at once).`)
    }
    throw e
  }
}
