// Shared instructions for the "is this test a good automation candidate"
// field, used by every AI prompt that generates or rewrites test cases
// (generateTestCasesFromRequirements.js, combineTestCases.js).
//
// automationCandidate used to mean "is this technically scriptable" —
// which made a trivial "form shows a validation error" check just as
// eligible as a real top-to-bottom checkout flow, since both have
// deterministic steps and a clear assertion. That conflated two different
// questions. It's reserved now for the curated, deliberately small set of
// critical, cross-cutting, top-to-bottom flows produced by the dedicated
// "review critical flows" path (generateCriticalFlows.js) — not something
// per-requirement or combine generation should set true on their own.
export const AUTOMATION_GUIDANCE = `- "automationCandidate": boolean — almost always false. This is reserved for a small, deliberately curated set of critical end-to-end flows maintained separately (via a dedicated "review critical flows" pass that reasons over the whole requirement set at once) — not something to set true here just because a test happens to be scriptable. Mark true only in the rare case this individual test IS itself already a genuine, self-contained, top-to-bottom critical journey through the app's core functionality — not merely because it has deterministic steps and a clear assertion.
- "automationReasoning": string — one short sentence explaining the automationCandidate call (omit or leave empty when automationCandidate is false)`
