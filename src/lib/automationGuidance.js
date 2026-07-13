// Shared instructions for the "is this test a good automation candidate"
// field, used by every AI prompt that generates test cases (originally
// only testCases.js's freeform generation; now also the requirement-driven
// generation in generateTestCasesFromRequirements.js).
export const AUTOMATION_GUIDANCE = `- "automationCandidate": boolean — true if this test is a good candidate for test automation
- "automationReasoning": string — one short sentence explaining the automationCandidate call

Guidance for automationCandidate: mark true when the test has deterministic, scriptable steps and a clear pass/fail assertion — e.g. form submission, API/data validation, CRUD flows, navigation, repeated regression checks. Mark false when the test relies on subjective human judgment — e.g. visual/layout review, usability or copy review, CAPTCHA, one-off exploratory testing, or steps needing something automation can't easily do (email/SMS retrieval, third-party approvals, physical devices).`
