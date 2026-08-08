// Shared instructions for the "is this test a good automation candidate"
// field, used by every AI prompt that generates or rewrites test cases
// (generateTestCasesFromRequirements.js, combineTestCases.js).
//
// Back to the broader "is this technically scriptable" meaning: any test
// case with deterministic steps and a clear pass/fail assertion is eligible,
// not just curated critical end-to-end flows or API tests — a
// straightforward functional or integration check is just as valid a
// candidate as a top-to-bottom journey, as long as it doesn't rely on human
// judgment (visual design review, subjective wording, etc.) to verify.
export const AUTOMATION_GUIDANCE = `- "automationCandidate": boolean — true if this test case is a good fit for automation: deterministic steps, a clear pass/fail assertion, and no reliance on human judgment to verify. Not limited to critical end-to-end flows or API tests — functional and integration checks are equally eligible whenever they're reliably scriptable. False only when the test genuinely can't be scripted reliably (e.g. it depends on subjective visual/design judgment, or on something outside the app's own behavior).
- "automationReasoning": string — one short sentence explaining the automationCandidate call (omit or leave empty when automationCandidate is false)`
