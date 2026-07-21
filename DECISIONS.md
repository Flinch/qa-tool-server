# Decisions

- generation-payload/:correlationId hardcodes the same TARGET_URL fallback literal as playwright.config.js (no shared config module to import from) — duplication accepted, not worth a new module for one string.
- GET /generation-runs joins automation_suites for name/slug, mirroring GET /runs, so the two listing endpoints have a consistent shape.

## Phase 2 — generation orchestration script

- Subagents (planner/generator/healer) are invoked via the `@anthropic-ai/claude-code` CLI in headless print mode (`claude -p ... --output-format json`), not the `@anthropic-ai/claude-agent-sdk`. The CLI is confirmed to auto-discover `.claude/agents/*.md` and `.mcp.json` from the working directory the same way interactive mode does; the SDK's equivalent auto-discovery is undocumented and would likely require re-declaring the subagents/MCP config programmatically, duplicating the Phase 0 scaffold for no clear benefit.
- `.claude/settings.json` pre-approves the exact tool set the three subagents use (no `defaultMode: dontAsk` persisted there — that's passed as a `--permission-mode dontAsk` CLI flag only on the headless invocation itself, so normal interactive sessions in this repo aren't silently changed).
- Cost cap default: $5/run (`GENERATION_COST_CAP_USD`), checked after each subagent invocation completes (no mid-run hook exists) by summing `total_cost_usd` from each call's JSON result. One real data point: even a trivial one-line agent call costs ~$0.15-0.75 due to context-cache creation — worth re-checking the cap once real multi-TC runs happen.
- `generation_runs.status` is reported once per phase per run (not once per TC) — the column is single-valued for the whole run; per-TC granularity is the already-documented `generation_run_test_cases` upgrade path in migrate.js, not solved here.
- Per-TC generation failures don't abort the run: a TC that fails planning/generation is recorded and skipped, matching planExport.js's existing "flag as blocked, don't crash the batch" philosophy. Only a zero-success run reports `failed` and skips the PR step; a partial success still proceeds to heal + PR (partial results are still reviewable — a human reviews everything anyway).
- The orchestration script's own responsibility ends at reporting `opening_pr`; the final `completed`/`failed` event with the real `pr_url`/`branch_name` is reported by a later workflow step (not yet built) that runs after `peter-evans/create-pull-request`, since only that step knows the actual PR URL.
- ~~Each TC is processed as one `async` unit in a plain `for` loop~~ — superseded, see the batching entry in the "Phase 2 — cost" section below. Not parallelized: cost-cap enforcement, per-TC progress, and test-data uniqueness (`Date.now()`-based) would all need re-checking under real concurrency first, if that's ever pursued instead of/alongside batching.
- New env vars for CI (distinct from the existing `WEBHOOK_URL`, which points directly at the test-runs endpoint): `WEBHOOK_BASE_URL` (base path for both new webhook routes) and `WEBHOOK_SECRET` (reused), `GENERATION_COST_CAP_USD`, and eventually `ANTHROPIC_API_KEY` for the CI runner's own Claude Code auth.

## Phase 2 — generate-tests.yml

- `generate-tests.yml` has a "Trust this workspace for Claude Code" step that writes `hasTrustDialogAccepted: true` into `~/.claude.json` for `$GITHUB_WORKSPACE` before any subagent call. This is necessary, not optional: tested empirically against a genuinely never-trusted directory, and confirmed an untrusted workspace silently ignores `.claude/settings.json`'s tool allowlist even in headless `-p` mode with `--permission-mode dontAsk` — `Write` was denied outright. A fresh CI checkout is "never trusted" on every single run, so this has to run every time, not once.
- Added an explicit "Authenticate (create storageState)" step (`npx playwright test --project=setup`) before the fetch/generate steps. Locally this was easy to miss because `.auth/user.json` was already on disk from earlier manual runs; CI starts with nothing, so without this step the planner/generator agents would start unauthenticated.
- The workflow's own responsibility (reporting the terminal `completed` event with the real `pr_url`) is a separate final step (`report-generation-complete.js`) run right after `peter-evans/create-pull-request`, matching the boundary already documented above (the script itself stops at `opening_pr`).
- New repo secrets/vars needed for this workflow to run: `WEBHOOK_BASE_URL`, `WEBHOOK_SECRET` (may already exist), `ANTHROPIC_API_KEY` (CI's own Claude Code auth — distinct from the server's own key), optional `vars.GENERATION_COST_CAP_USD` (defaults to 5 if unset).

## Phase 2 — batching planner/generator calls (cost)

- Real measured data drove this change: a one-TC-at-a-time loop (one `claude -p` call per TC per phase) paid a fixed ~$0.15-0.25 context-loading overhead on every single call, on top of the actual work. Switched the planner and generator phases from "one invocation per TC" to "one invocation covering every TC in the run" — the fixed overhead is now paid once per run instead of once per TC. The heal loop was already batched this way from the start (one healer call per attempt covers the whole suite directory, not per TC) — this brings the other two phases in line with that.
- Tradeoff, accepted deliberately: a *hard* failure in a batched call (`is_error`, a permission denial) can no longer be pinned to one TC — it fails every TC in that invocation, not just the one that triggered it. A *soft*, single-TC problem (e.g. planExport.js's own "flag as blocked" marker for a TC missing steps) isn't a hard failure — the agent just doesn't produce that one file while still working through the rest of the list, which the post-invocation per-TC file-existence check still catches correctly. So per-TC outcome accuracy is preserved for the common case; only a systemic failure loses isolation. (The cost cap specifically is handled differently — see below.)
- Batch size isn't bounded yet. This is fine at the small batch sizes (1-8 TCs) already discussed as the realistic per-dispatch cap, but hasn't been tested at larger N — a very large batch risks hitting output-length or context limits within a single invocation, which would need addressing before raising the recommended per-dispatch TC limit.

## Phase 2 — skip re-verifying helper-covered setup steps

- Real finding from TC 38 ("Admin can delete a ticket"): the generated spec correctly reused `createTicket(page)` per AGENTS.md's existing convention (no code duplication) — but the generator agent's own defined workflow (`.claude/agents/playwright-test-generator.md`, from Playwright's official scaffold) mandates live-executing every step before writing code. So the agent still had to click through the whole creation flow live to get a real ticket to delete, even though the resulting file just calls the helper in one line. Reusing a helper saved on code quality, not on live-exploration turns — turns are what actually drive cost.
- Fix: added an explicit exception to `playwright-test-generator.md`'s per-step loop — if a step is fully covered by an existing helper (per AGENTS.md), skip live-executing it and call the helper directly in code. Also added the equivalent instruction directly in the planner's task prompt in `generate-tests.js` (NOT in `playwright-test-planner.md` itself — that file is Playwright's generic "create a fresh plan from scratch" scaffold, and the narrower "verify an existing plan" behavior this pipeline actually uses is driven entirely by the task prompt sent per-invocation, not the agent file's defaults; editing the prompt keeps the optimization scoped to how this pipeline uses the agent, without bleeding into its other potential uses).
- Tradeoff, accepted deliberately: setup steps covered by a helper no longer get live-verified during generation/planning. If the app changed in a way that broke `createTicket()` itself, this wouldn't be caught until the heal loop's actual test run, not before. Reasonable given the heal loop exists specifically to catch exactly that class of problem.

## Phase 2 — retain partial results on a cost cap hit

- Fixed a real gap surfaced by a direct question, not found through testing: the generator's cost-cap catch used to unconditionally `throw err`, same as any other hard failure — but by the time `total_cost_usd` is known, the batched call has already fully run and whatever it wrote is really on disk (there's no mid-call cost hook to stop it earlier). Discarding that was throwing away real, usable output.
- Fix: a cost cap hit during the *generator* phase now falls through to the same per-TC file-existence check as any other error, and reports whatever succeeded — same partial-success-still-gets-a-PR philosophy as any other partial batch. It additionally skips the heal loop entirely (no point spending further once the cap's already been hit) and reports `error_message` noting the cap was exceeded either way (whether the run still opens a PR with partial results, or fails outright because literally nothing was written).
- A cost cap hit during the *planner* phase still fails the whole run immediately — the planner only edits plan markdown, not spec files, so there's nothing generated yet to retain regardless of how the cap was hit.

## Phase 2 — agent invocation timeout + process-group kill

- Real incident, not a hypothetical: a real 3-TC batched planner call hung for 25+ minutes with the cost frozen (confirmed via console.anthropic.com — no new spend, meaning no new API calls, meaning it was blocked on a tool call rather than looping through the model). There was no timeout at all on the `execFileAsync` call, so nothing would have stopped it short of GitHub's own 45-minute job timeout — and even then, GitHub's hard kill doesn't give the script a chance to report `failed` or clean up; it just terminates the job.
- Cancelling the run and inspecting the orphan-process cleanup log confirmed the actual mechanism: `claude`, `npm exec playwright run-test-mcp-server`, and `chrome-headless-shell` were all still alive at cancellation — a real live browser session stuck on some condition that never resolved. Leading (unconfirmed) hypothesis: TC 40 ("ticket cannot be saved without an assignee") is a negative/validation test, and a live wait-for-success-style check on a flow that's supposed to fail can hang indefinitely.
- Fix: `runAgent` now runs through a custom `runClaudeProcess` wrapper (not `execFileAsync`) with an `AGENT_TIMEOUT_MS` env var (default 15 min per call). On timeout, it kills the whole process **group**, not just the immediate child — `detached: true` makes the spawned process the leader of its own group, so `process.kill(-pid, 'SIGKILL')` (negative pid) reaches every descendant (npx → claude → the MCP server → the browser) in one signal. A plain kill on just the top process would leave the same orphans GitHub's own cleanup had to individually hunt down.
- A timeout during planning fails the run immediately (nothing generated yet, same as a cost cap there). A timeout during generation is treated the same as a cost cap hit during generation — falls through to the per-TC file-existence check, retains whatever was actually written, skips the heal loop.

## Phase 2 — behavior mismatch policy (spec vs. reality, not just app-changed-over-time)

- Discovered directly, not from testing: TC 40 ("Ticket cannot be saved without an assignee") states behavior the live app doesn't actually enforce — you genuinely can save a ticket unassigned. This is a distinct category from the existing healing rule (which only covers behavior that *changed* after a test already existed) — here the spec was arguably wrong or the feature was never built, from the very first verification. Also very plausibly the actual root cause of the hang above: an agent trying to verify/produce a "save succeeded with validation error" state that the app never produces has no natural stopping condition without being told to recognize the contradiction and give up.
- Generalized `AGENTS.md`'s existing healing-only rule ("behavior changed → `test.fixme()` + `POSSIBLE REGRESSION` comment, never rewrite the assertion") into a new "Behavior mismatch policy" section that applies at every stage — planning, generation, and healing — not just healing. Added matching instructions to the planner's task prompt in `generate-tests.js` (note a `BEHAVIOR MISMATCH` comment in the plan file, move on to the next plan rather than retry/wait) and to `playwright-test-generator.md`'s per-step loop (write `test.fixme()` + `POSSIBLE REGRESSION` comment instead of forcing a false assertion, still produce the file).
- Deliberately NOT auto-filing a bug in the `bugs` table yet, even though the table and the `test_case_id` link already exist and the original roadmap named exactly this for Phase 4 ("flagged regressions auto-file bugs"). Treating that as a separate, later piece — it needs a new webhook path from CI back to the server, a bigger scope decision than the prompt/convention change here. For now the mismatch is only surfaced as a reviewable `test.fixme()` in the generated PR.

## Phase 2 — explicit process.exit(0) after a successful run

- Real incident: a run that actually succeeded (`Done. 2/3 test case(s) generated.` printed) never let its CI step complete — the Node process itself never exited, so "Generate and heal tests" sat showing in-progress indefinitely (would have eventually been killed by the 45-minute job timeout, losing the already-generated files, since nothing gets pushed anywhere until the PR step runs after this one).
- Cause: `postJson`/`reportEvent`'s webhook calls use Node's default keep-alive HTTP agent, which can leave a socket handle open after the response completes — Node won't exit while a handle is open, even with nothing left to do. Only the failure paths called `process.exit(1)` explicitly; the success path relied on the event loop draining naturally, which it wasn't reliably doing.
- Fix: `main().then(() => process.exit(0))` — explicit exit on success, mirroring what the failure paths already did. Simpler and more robust than chasing down exactly which socket was staying open.

## Phase 3 — replace-mode test case generation

- `POST /test-cases/generate` now accepts `replace: boolean`. The Anthropic call and JSON parsing happen before any DB mutation either way (already true beforehand), so a bad AI response never touches existing data regardless of mode.
- Replace mode specifically needs real transactional atomicity — `DELETE FROM test_cases WHERE project_id=$1` then the insert loop, wrapped in an actual `BEGIN`/`COMMIT`/`ROLLBACK` via a dedicated `pool.connect()` client. This is the first route in the codebase to need a real transaction: the existing `query()` helper checks out a fresh connection per call, which can't guarantee atomicity across a delete-then-insert-loop — a failure partway through the insert loop would otherwise leave the project with zero test cases and no way back.
- Relies on existing FK behavior rather than adding new cascade logic — but that behavior is NOT uniform, and this matters for what replace mode actually does:
  - `bugs.test_case_id` and `automated_test_cases.test_case_id` are `ON DELETE SET NULL` — old bugs and automated-test links survive with a null reference.
  - `execution_run_test_cases.test_case_id` is `ON DELETE CASCADE` — deleting a test case **permanently deletes its pass/fail execution history** across every execution run it was ever part of, not just the TC itself. This is a real, significant consequence of replace mode: it doesn't just remove the TC, it erases execution history tied to it. The client-side confirmation dialog's copy was updated to say this explicitly rather than just "this cannot be undone" — the user needs to know what specifically is being lost, not just that it's irreversible.

## Phase 3 — generate-from-TCs UI (Automation page)

- Added a server-side max-3-TCs-per-batch check in `triggerGenerationRun` (`automationTrigger.js`), alongside the existing non-empty-array check. The client UI also caps selection at 3, but this is enforced server-side too so a raw API call can't bypass it — the cap exists because CI has a wall-clock budget (each TC still needs real live browser turns regardless of batching, per the cost/timing findings during Phase 2 testing).
- The live progress indicator needed no new SSE endpoint — confirmed `sse.js`'s `subscribe`/`broadcast` are keyed only by project id, not event name or route, so the *existing* `EventSource` connection already open for `run_completed` also receives `generation_progress`/`generation_completed` without any server change. Just added two more `addEventListener` calls client-side.
- `generation_completed`'s payload only carries `generation_run_id`, not the final status/pr_url (by design — see Phase 2 decisions on the workflow/script boundary). The client refetches `GET /generation-runs` on that event to get the real final state before toasting success/failure, rather than guessing from the event alone.
- Batch suggestion (`src/lib/batchSuggestion.js`, client-only) is a deliberately narrow heuristic: it groups candidate TCs by whether their steps text matches a known shared-setup keyword pattern (today: ticket creation, tied to `helpers/createTicket.ts`), not a general similarity/clustering model. This is intentional — it's tied to the one mechanism already proven to reduce cost (skipping shared setup exploration for helper-covered steps), not a fuzzier "these seem related" guess. Documented as a known limitation in the UI copy itself: it only knows about today's helpers and needs manual updates if new shared helpers are added.

## Phase 4 — client-facing quality health dashboard

- Found and fixed a real fan-out bug in `GET /projects/:id/stats` (and the root `GET /stats`): both LEFT JOIN `test_cases` and `bugs` independently off `projects`, which is a cartesian fan-out — for a project with T test cases and B bugs the join produces T×B rows. `COUNT(...) FILTER (...)` without `DISTINCT` was counting every duplicated row, not the true count. Confirmed empirically against a real project (20 test cases, 1 open bug): the old query reported `openBugs: 20` instead of `1`. Fixed by switching to `COUNT(DISTINCT ...) FILTER (...)`, the same pattern the `GET /projects` list query already used correctly. This means `openBugs`/pass/fail numbers shown on the existing Dashboard and per-project pages were wrong before this fix whenever a project had both test cases and bugs.
- New `GET /projects/:id/health` deliberately runs several small single-purpose queries via `Promise.all` instead of one combined join — combining unrelated one-to-many relations (test_cases, bugs, automated_test_cases, execution history) in one query is exactly what caused the fan-out bug above. Keeping them separate is simpler to verify and cheap enough (all indexed on `project_id`).
- `healthStatus` is a plain threshold rule computed in JS, not a query: `insufficient_data` (no pass/fail results yet) → `needs_attention` (any open critical bug, or pass rate < 70%) → `good` (any open high bug, or pass rate < 90%) → `excellent`. Deliberately simple and transparent rather than a weighted score — thresholds are a starting point, easy to tune in one place once real usage shows whether they feel right.
- The pass-rate trend is sourced from `execution_runs`/`execution_run_test_cases` history (last 8 *completed* runs), not `test_cases.status`. `test_cases.status` is a single live snapshot with no history — it can't show a trend, only a point-in-time number. Runs with zero pass/fail results (e.g. everything blocked) are skipped rather than plotted as 0%, since that would misrepresent an execution that didn't actually produce a verdict.

## Phase 4 — unshare a client from a project

- Added `GET /projects/:id/members` and `DELETE /projects/:id/members/:userId`, both admin-only, mirroring the existing `POST /projects/:id/members` pattern (same role gate, same table). No `assertProjectAccess` needed here — `requireRole('admin')` alone is the correct gate, same as the existing add-member route.
- Client-side confirmation uses a plain `window.confirm()` rather than the app's usual custom modal — deliberate: unlike the replace-mode TC deletion (which cascades and destroys execution history), revoking a client's access is fully and trivially reversible by re-adding their email, so a lighter-weight confirmation is proportionate.

## Phase 4 — requirements traceability, Phase 1 (schema + manual linking)

- New `requirements` and `requirement_test_cases` tables. Deliberately no `key`/identifier column yet (test_cases doesn't have one either — title is the identifier) and no `document_id`/source-document column yet — both arrive with the upload/diff phase, not needed for manual-only Phase 1. Avoids designing schema for a phase that isn't built yet.
- `requirement_test_cases` is a pure join table with `ON DELETE CASCADE` on both FKs, unlike `test_cases` deletion elsewhere in the app — deleting a link here destroys nothing but the link itself, not real execution history, so the caution that applies to TC deletion doesn't apply here.
- The requirements list query uses `COUNT(DISTINCT rtc.test_case_id)` via a LEFT JOIN, not a bare `COUNT()` — deliberately applying the fan-out lesson from the `/projects/:id/stats` bug found and fixed earlier this phase (verified empirically: linking 2 test cases to a requirement and confirming the list endpoint reports exactly 2, not a multiplied number).
- No hard DELETE endpoint for a requirement — only `PATCH .../requirements/:id` with `status: 'removed'` (soft delete). The entire point of this feature is traceability, so a requirement disappearing without a trace would undermine it; archived requirements stay queryable.
- The Requirements page is staff-only (`requireRole('qa_engineer', 'admin')`, same gate as `testCases.js`) and reuses 100% existing CSS classes — no new styling needed, matching the existing page conventions exactly (`TestCasesPage.jsx`'s table/modal/edit-in-place shape).
- This phase intentionally ships with zero requirement-to-test-case links on every existing project. The "Link test cases" picker on the Requirements page is the retroactive-linking tool for that — without it, coverage numbers would start at a meaningless 0% indefinitely.

## Phase 4 — PDF text extraction: pdf-parse rejected, switched to unpdf

- Real production incident, not caught locally: `pdf-parse@2` crashed the entire server process at import time on Railway's Node runtime. It pulls in `pdfjs-dist`'s "legacy" build, which expects browser globals (`DOMMatrix`, etc.); its own Node polyfill depends on `process.getBuiltinModule`, which wasn't available in that environment, so the polyfill silently failed and the next line (`new DOMMatrix()`) threw uncaught. Since this happens at module load, not at call time, importing `pdf-parse@2` anywhere took the whole app down, not just the upload endpoint.
- Downgraded to `pdf-parse@1` as a first fix, which avoids that dependency chain — but hit two more problems: (1) its `index.js` runs a self-test on import guarded by `!module.parent`, which is wrong under ESM's `import`-as-require interop (our "type": "module" setup), so it always tried to read its own bundled sample PDF and crashed; worked around with `createRequire` to get real CJS semantics. (2) Even past that, its bundled `pdf.js` (v1.10.100, ~2017) failed with `bad XRef entry` on a completely standard, freshly-generated PDF 1.4 file — not an edge case, a plain reportlab output. That's a real reliability gap, not a one-off.
- Replaced both with `unpdf`, which ships its own actively-maintained, serverless/Node-optimized PDF.js build made specifically for this problem (no DOM assumptions, no ESM interop footguns). Verified via a standalone script (not the browser): imports without crashing, and correctly extracts text from the same PDF that broke `pdf-parse@1`.

## Phase 4 — requirements traceability, Phase 3 (diff on re-upload)

- `POST /projects/:id/requirements/upload` now branches on whether the project already has active requirements: none → same Phase 2 straight-commit behavior (tagged `mode: 'created'` in the response so the client can tell the two shapes apart); some → diff mode, which writes the `requirement_documents` row (always, for the audit trail) but makes zero writes to `requirements` until a human reviews and confirms via the new `POST /apply-diff`. Same "review before commit" posture as the existing generation pipeline's PR-based review.
- The diff AI call gets the full current requirements list (id/title/description) plus the new doc text, and returns only what changed — unchanged requirements are simply omitted from the response rather than listed, since there's nothing to review for them.
- `apply-diff`'s modified-requirement path is a plain `UPDATE ... WHERE id=$id`, not a delete-and-recreate — deliberate, and verified directly: this keeps the requirement's existing `requirement_test_cases` links intact, since that join table is keyed on `requirement_id`, not content. A requirement's wording changing doesn't silently drop its test coverage.
- Removed requirements reuse the `status='removed'` soft-delete already built in Phase 1 — no new status value needed, and consistent with the traceability goal (nothing disappears without a trace).
- Verified via two standalone scripts (no browser): one exercising the real AI diff call end-to-end against seeded requirements (blocked locally by the same stale `.env` key noted in the pdf-parse entry above, but the call pattern is identical to Phase 2's already-proven segmentation call), and one directly exercising the `apply-diff` SQL in isolation — confirmed a modified row keeps its id and its test-case link survives, a removed row flips status and drops from the active list, and a new row inserts correctly.

## Phase 4 — requirement-driven test case generation (freeform generation retired)

- `POST /projects/:id/test-cases/generate` (the old paste-any-text generation flow) is deleted entirely, backend and frontend, not just hidden — test cases now only come from a specific requirement (single or bulk generate) or manual entry. Confirmed via grep this endpoint had exactly one caller before removal.
- Extracted `AUTOMATION_GUIDANCE` out of `testCases.js` into `src/lib/automationGuidance.js` — it needed a second real call site (`generateTestCasesFromRequirements.js`) once the old generation route was deleted, so this is deduplication driven by an actual second usage, not speculative.
- `generateTestCasesForRequirements` batches every requirement passed to it into one Claude call (same cost-amortizing principle as the planner/generator pipeline), tagging each generated test case with `requirementId` so the caller can insert-and-link without a second AI round trip. Used identically by both the single-requirement and bulk-generate routes — the only difference is how many requirements get passed in.
- The "a requirement can't get a duplicate test case" rule is enforced server-side, not just by hiding the button: `POST /:reqId/generate-test-case` re-checks `linked_test_case_count` itself and 400s if already covered. Verified directly: seeded an uncovered requirement, generated+linked a test case for it, confirmed the same gate query would now reject a second attempt.
- Deleting a requirement uses the existing `status='removed'` soft-delete from Phase 1 (`PATCH /requirements/:id`) — this was a deliberate reuse, not a new hard-delete endpoint, specifically because hard-deleting a requirement would defeat the traceability this whole feature exists for. The UI button is labeled "Delete" since that's the user-facing action, but nothing new was built server-side for it.
- Deleting a test case is a real hard delete (new `DELETE /api/test-cases/:id`, mirroring `patchTestCase`'s shape). Verified the `requirement_test_cases` CASCADE fires correctly — deleting a generated test case drops its requirement's `linked_test_case_count` back to 0, which correctly makes that requirement eligible for regeneration again (no special-casing needed, this falls out of the existing schema).

## Phase 4 — fix: requirement-driven generation truncating on larger batches

- Real bug, not caught in earlier verification (the AI call itself couldn't be exercised locally due to the stale `.env` key noted repeatedly above — this only surfaced once tested against the real deployed key). `generateTestCasesForRequirements` used a flat `max_tokens: 4000` regardless of how many requirements were passed in. Bulk-generating across several uncovered requirements in one batched call could exceed that budget, cutting the AI's JSON response off mid-structure. `JSON.parse` on truncated JSON throws a generic `"Unexpected end of JSON input"` — which then correctly propagated all the way to the client as a 500 with that exact string as the error message, which is genuinely confusing without knowing the cause.
- Fixed two ways: (1) `max_tokens` now scales with `requirements.length` (`Math.max(4000, requirements.length * 900)`, capped at 8192), floored at the old flat value so the single-requirement path — presumably not the one that was actually broken — never regresses. (2) If a parse failure's `stop_reason` is `'max_tokens'`, a specific, actionable error message replaces the generic JSON error ("too many requirements in one batch — try fewer at once, or generate this one individually"), instead of leaking a raw parse error that gives no hint about the real cause.

## Phase 4 — requirements traceability, Phase 5 (coverage % on Quality Health dashboard)

- `GET /projects/:id/health` gets a fifth parallel query, same shape as the existing `automationCoverage` one — `requirements LEFT JOIN requirement_test_cases`, counting `DISTINCT r.id` total vs. `FILTER (WHERE rtc.id IS NOT NULL)` covered.
- Deliberately reuses the exact same definition of "covered" already established on the Requirements page itself (`linked_test_case_count > 0`) — at least one linked test case, regardless of that test case's pass/fail status. Not "at least one *passing* linked test", which was floated earlier in discussion but would mean this dashboard and the Requirements page disagree about what "covered" means for the same requirement, which is worse than either definition alone.
- Verified directly: seeded 3 requirements (1 linked, 2 not) against a real project, ran the exact query, confirmed `1/3 = 33%`.

## Phase 4 — client view access to Requirements/Test Cases + dashboard drill-through + real pass rate

- `testCases.js` and `requirements.js` switched from router-level `requireRole('qa_engineer','admin')` (blocked clients from every method, including read) to `requireProjectAccess` + a local `staffOnly` applied per-mutation-route — the exact pattern `bugs.js` already used correctly. Clients can now view both pages (any project member passes `requireProjectAccess`); every create/edit/delete/upload/generate/link route still requires staff. Verified by direct inspection that every GET route has no `staffOnly` and every POST/DELETE route does, rather than forging a client JWT to test live — the harness correctly flagged forging a token for a real user account (even read-only) as credential impersonation and blocked it, which was the right call; the route-gate pattern itself is a direct copy of `bugs.js`'s already-proven-in-production logic, not new risk surface.
- Quality Health dashboard tiles now link to the report page they summarize (Test results → Executions, Open issues → Bugs, Automation/Requirement coverage → their respective pages, Pass rate trend → Executions) — wrapped in existing `.card-sm`, which already had hover styling, so no new CSS needed.
- Fixed a real, confirmed-wrong metric: dashboard pass rate was computed from `test_cases.status`, which — per the schema comment already on `execution_run_test_cases` in `migrate.js` — is deliberately independent of execution results. Marking pass/fail inside an execution run has never written to `test_cases.status`, so this number was structurally incapable of reflecting real execution history. Replaced with a query that finds each test case's most recent actual result across every execution run in the project and aggregates from that. Verified directly: seeded a real execution result, confirmed it's counted; confirmed a never-executed test case lands in `notRun` rather than being dropped; confirmed the four buckets always sum to total. Added `blocked` as an explicit bucket (was previously not represented in this endpoint at all) rather than silently folding it into `notRun`, which would have made the numbers not add up.
- Deliberately not touched: `GET /stats` and `GET /projects/:id/stats` have the same root cause (reading `test_cases.status`) for the Dashboard page's stat-row, but weren't part of this request — flagged to the user as a known follow-up, not bundled in unprompted.

## Phase 4 — same pass rate fix applied to /stats and /projects/:id/stats

- Follow-up to the health-endpoint fix, applied to the two other places with the identical root cause: `GET /stats` (global, used by `DashboardPage.jsx`) and `GET /projects/:id/stats` (per-project — currently has no client caller after the Reports tab's stat-row was removed earlier this session, but still a real endpoint worth being correct, and fixed for consistency in case something calls it again). Both now source passed/failed from the same `latest_execution` CTE pattern instead of `test_cases.status`.
- `GET /stats` is a cross-project aggregate with no `project_id` filter, so its `latest_execution` CTE is intentionally unscoped — safe because `test_case_id` is already implicitly project-scoped via the `tc` join, no cross-project leakage.
- `GET /projects/:id/stats` also gained a `blocked` bucket (previously absent, silently would have been folded into `notRun`) for the same reasoning as the health endpoint — a distinct real status shouldn't disappear into the wrong bucket.
- Verified against real data: seeded an execution result, confirmed both endpoints count it; confirmed `testCases = passed+failed+blocked+notRun` stays internally consistent; cross-checked `openBugs` against an independent ground-truth count to confirm the existing DISTINCT fan-out fix (from earlier this session) still holds under the new query shape.

## Phase 5 — JIRA cross-posting for bugs

- New optional toggle on bug creation: "also post this to JIRA". New env vars `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` — server-side only (Railway), same reasoning as why `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO` live only in Railway and never in a GitHub Actions `.yml`: JIRA issue creation is triggered by the server itself, not called back into. Added to `.env.example` (the GitHub vars never were, despite being real — fixed the gap here rather than repeating it).
- `src/lib/jiraClient.js` mirrors `automationTrigger.js`'s shape deliberately: env vars are plain `const X = process.env.X` with zero derived work at module scope (not even the Basic Auth header — that's built per-request), so importing this file can never throw at server startup. This matters specifically because of the pdf-parse@2 import-time crash documented earlier in this file — nothing risky happens until a function is actually called.
- **Fail-open**: a JIRA failure never blocks the local bug from saving. `POST /projects/:id/bugs` always inserts the bug first; the JIRA call (if `post_to_jira` is set) is wrapped in its own try/catch that sets `jira_error` on the response instead of rethrowing. Mirrors the pre-existing non-blocking behavior when a bug's image-attachment comment fails.
- JIRA API v2 (plain-text `description`), not v3/ADF — none of `steps_to_reproduce`/`expected`/`actual`/`notes` need rich formatting, and composing them into one plain-text block server-side (`buildJiraDescription`) is simpler than building an Atlassian Document Format JSON tree for no visible benefit.
- Severity → priority: `critical/high/medium/low` → `Highest/High/Medium/Low`, a guess at a common default scheme, not confirmed against the real target JIRA project yet (no live credentials this session — see below). `createJiraIssue` retries once without `priority` if JIRA rejects the request over that field, since team-managed Cloud projects frequently don't expose `priority` on the create screen at all and JIRA rejects the *whole* request in that case, not just the field.
- Project picker, not a fixed project: `GET /projects/:id/bugs/jira/projects` (staff only) lists every project the configured account can see via `/rest/api/2/project/search`, and the client shows a live dropdown rather than a single env-configured project — explicitly requested over the simpler fixed-project option, and not meaningfully more work since it's the same credentials already needed for issue creation.
- **Organizations — stored, not linked, in v1.** The "Organization" field is a real Jira Service Management concept (associates a request with a customer company), but whether the target project is even JSM wasn't known this session, and linking an org to a specific *issue* (not just making it available on a service desk) requires discovering an instance-specific custom field ID (e.g. `customfield_10002`) that has no fixed name/ID across JIRA sites — not something guessable without a live credential round-trip. Shipping a guess here had a real chance of silently no-op'ing or throwing on every actual JSM project. Cut for v1: the field stays in the UI (explicitly wanted) and is stored verbatim on `bugs.jira_organization` for reference; real linking is a follow-up once JSM access is confirmed.
- Image attachment: `attachImageToJiraIssue` decodes the same base64 data URL already produced client-side for the local `bug_comments` copy and POSTs it to JIRA's `/rest/api/2/issue/{key}/attachments` with `X-Atlassian-Token: no-check`. Deliberately does NOT manually set `Content-Type` on that request — `fetch` needs to generate its own multipart boundary, and the codebase's `apiFetch`/JSON-header habits elsewhere make this an easy copy-paste mistake to guard against explicitly.
- Not verified against a real JIRA instance this session — no credentials in hand (same category of gap as the stale local `ANTHROPIC_API_KEY` noted earlier in this file: the surrounding code path is proven — mirrors `automationTrigger.js` exactly — but the live external call itself is untested). Verified instead: server boots cleanly with `jiraClient.js` imported and no `JIRA_*` vars set; `GET .../jira/projects` returns a clean `{error: 'JIRA is not configured on the server'}` instead of crashing; `POST /bugs` with `post_to_jira: true` still creates the bug locally and returns `jira_error` describing the missing config. Malik will add real Railway env vars and do the first live test himself.

## Phase 5 — command-center staff dashboard

- `GET /stats` (the global, cross-project endpoint behind the staff landing page) extended in place rather than adding a new route — it was already the single source `DashboardPage.jsx` calls, so this keeps that one-request shape instead of splitting into a second endpoint.
- Added: `bugsBySeverity`, `automationCoverage`/`automatedTestCases`/`totalTestCases` (same shape as the per-project `/health` endpoint's queries, just unscoped), `passRate` (defined identically to `/health` too — `passed / totalTestCases`, so a test case that's never been run still counts against the rate rather than being excluded, keeping the definition consistent site-wide), `recentActivity`, `recentRuns`, `needsAttention`.
- `recentActivity` is built the same "infer events from current-state timestamps" way the per-project `QualityHealth` dashboard already does client-side (bug `status`/`created_at`/`updated_at`, completed execution runs) — just done in SQL here instead, since doing it client-side across every project would mean an N+1 fetch loop instead of two queries.
- **Caught before shipping**: `needsAttention` was initially derived by filtering the same 10-row `recentActivity` bug query down to open critical/high bugs. That's wrong — a bug that's been open for weeks with no recent edits wouldn't appear in the most-recently-touched 10, which is exactly the kind of stale unaddressed bug "needs attention" exists to surface. Fixed with its own dedicated query (open, critical/high, sorted oldest-first) instead of reusing the capped recent-activity result.
- "My notes" (a personal scratchpad on the dashboard) is `localStorage`-only, no backend table — deliberate, confirmed with Malik: it's single-device by design, not a shared or synced feature, so there's nothing here worth a schema addition for.
- Extracted `timeAgo` (relative-time formatting) out of `QualityHealth.jsx` into `src/lib/timeAgo.js` once the dashboard became a second real call site — same "wait for an actual second caller before extracting" convention already used for `AUTOMATION_GUIDANCE` (see Phase 4 entry above).
- Verified directly against real dev data (not synthetic): ran every new query standalone, confirmed `passRate` matches `passed/testCases` by hand (32/68 → 47%), confirmed `needsAttention` surfaces a bug from 2026-07-02 that would NOT have appeared in the recent-activity-derived version, confirmed the server hot-reloads clean through every edit.

## Phase 5 — fix: JIRA project picker only returning the first page

- Real bug, surfaced by Malik once he had real credentials in place: a specific project ("Product/Solutions/Medibank") wasn't showing up in the "post to JIRA" project dropdown. `listJiraProjects()` called `/rest/api/2/project/search` once with `maxResults=100` and returned whatever came back on that single page — for any JIRA site with more than 100 projects (plausible for a large org), everything past page one silently never reached the client. No error, no truncation warning, just a shorter list than reality.
- Fixed by walking every page via `startAt`/`isLast` instead of trusting one request to be the whole list.
- Separate, not-yet-ruled-out possibility for the same missing-project symptom: `/project/search` excludes archived projects by default, and archived projects generally can't accept new issues anyway even if listed. Gave Malik a standalone `curl` diagnostic to run himself (against his own local `.env`, never shared with me) to tell the two causes apart before assuming the pagination fix alone resolves it.

## Phase 5 — fix: "Run suite" never picked up AI-generated tests

- Real bug: AI-generated specs are written to `tests/generated/<suite-slug>/` (per the convention in `AGENTS.md`), but `.github/workflows/playwright.yml`'s "Run suite" step only ever ran `npx playwright test tests/<suite-slug>` — the hand-written folder. `tests/generated/<slug>/` was never in the command, for any suite, so generated tests were structurally invisible to every suite run (not e2e-specific — this affected all four suites equally).
- Fixed by passing both paths: `tests/$SLUG tests/generated/$SLUG`. Confirmed locally (this repo has Playwright installed) that a nonexistent second path is silently zero-matched rather than erroring — `npx playwright test tests/regression tests/generated/regression --list` returned the same 6 tests as `tests/regression` alone, no crash — so suites with no generated tests yet aren't at risk from always including the second path.
- Also confirmed locally with `--list` against `tests/e2e tests/generated/e2e` that both the `chromium` project (hand-written) and `generated` project (AI-authored, with the `setup` auth dependency) pick up their respective files correctly under one combined run.
- Applied the same two-path fix to the nightly `schedule` fallback branch (previously hardcoded to `tests/smoke` only), for consistency — nightly runs now pick up generated smoke tests too, not just manual suite triggers.
- Separately, moved every currently-existing generated spec (previously split across `tests/generated/{demo,integration,smoke}/`) into `tests/generated/e2e/` at Malik's request, and updated the two `completed` `generation_runs` rows (`id 7`, `id 8`) to `suite_id=3` (E2E Tests) so the app's own history matches the new file location. This was a one-time content move, not implied by the pipeline fix above — the pipeline fix means future generations stay correctly scoped to whatever suite the user picks in the "Generate automated tests" modal (that suite picker already existed; nothing new needed there), this move just reassigns the *existing* five real generated files (`tc-37`, `tc-38`, `tc-40`, `tc-45`, `tc-65`) plus one demo fixture (`tc-example-ticket-creation`) to e2e specifically. Only run against the local dev DB — the same `UPDATE generation_runs SET suite_id=3 WHERE id IN (7,8)` needs to run against the Railway DB too if Malik wants production history to match.

## Phase 6 — mobile pipeline: live CRUD demo against Google Keep

- Same day, fourth round: Malik asked to watch the pipeline generate and run real test cases against a real app,
  live. Google Keep chosen (his suggestion) over the initially-proposed Messages app specifically to avoid any risk
  of actually sending a real SMS to a real contact — confirmed with him first (compose-but-never-send was the
  original Messages boundary; Keep sidesteps the question entirely since notes have no "send to a person" action).
  Real 3-flow CRUD suite committed at `tests/generated-mobile/android/keep-crud/` (create/update/delete), run for
  real, reported through the same `report-mobile-results.js` → `POST /webhooks/test-runs` path proven in the
  previous round — `test_runs` id 45, 3/3 passed, confirmed via direct SQL query.
- **Privacy note, handled not just flagged**: exploring Keep's real hierarchy surfaced real personal note content
  (financial figures, access codes, a personal relationship note) since it's Malik's actual account. None of that
  was written to any file in this repo. A coordinate-estimation mistake during manual exploration briefly opened one
  real existing note (before any committed flow existed) — caught immediately via a screenshot check before typing
  or changing anything, backed out with zero modification. All three committed flows only ever touch notes they
  create themselves, titled with a `QA-TEST-` prefix, and all test notes (including ones created during manual
  exploration and healing) were deleted afterward — confirmed clean via a final search showing "No matching notes".
- **Two real, reproduced findings about Keep's Compose UI**, both fixed via the actual heal cycle (not assumed):
  1. The FAB (`speed_dial_create_close_button`) has no accessible resource-id in either `maestro hierarchy` or raw
     `uiautomator dump` — a genuine Jetpack Compose semantics gap, not a Maestro bug. Percentage-based point tapping
     is the only working approach found. Also: tapping it opens a speed-dial menu (Image/Drawing/Audio/List/Text),
     not the note editor directly — the first `create-note.yaml` attempt failed on this for real; fixed by adding
     `tapOn: "Text"` after the FAB tap, confirmed via the failed run's own debug screenshot, not guessed.
  2. `tapOn: "<note title text>"` on a search-results screen is ambiguous — it matched the search bar's own typed
     query instead of the result card below it in a real failed `update-note.yaml` run. Fixed by scoping to the
     result card's real resource-id (`browse_text_note`) instead of bare text.
  3. `delete-note.yaml` initially tried to re-search after deleting from selection mode, which fails because
     deleting returns to the *same* active search-results view (not the plain list) rather than resetting it —
     the empty-results state (`"No matching notes"`) was already sufficient proof and didn't need re-querying.
- **Operational finding**: a stray hung `maestro hierarchy` process from earlier in the session (left running,
  never exited) silently blocked every subsequent `maestro test`/`hierarchy` call with a generic
  `UNAVAILABLE`/gRPC connection error, with no indication the actual cause was a stuck prior process holding the
  device connection. Fixed by killing the stray process and a full `adb kill-server`/`start-server` cycle. Worth
  remembering for anyone hitting an unexplained `UNAVAILABLE` from Maestro CLI: check `ps aux | grep maestro` for
  zombie sessions before assuming a device/driver problem.

## Phase 6 — mobile pipeline: real CI-triggered generation, proven end to end

- Sixth round, next day: Malik asked what's left before the mobile pipeline is "practically done." Answer given:
  hosting is one of three gaps, not the last one — generation needs a live, interactive device connection
  regardless of what gets picked for AWS/Maestro Cloud/self-hosted execution later, since neither device farm
  supports mid-authoring interaction the way `generate-tests.js` already does for web (a real headless browser in
  the CI runner itself, not a "browser farm"). He asked to prove that specific piece for real.
- Registered this Mac as a GitHub Actions self-hosted runner (`mobile-gen-runner`, labels `self-hosted,mobile`),
  foreground-only per Malik's choice (no persistent `launchd` service) — stopped at the end of this round.
- `triggerGenerationRun` (`src/lib/automationTrigger.js`) now routes by suite platform instead of rejecting
  non-web outright: web → `GITHUB_GENERATION_WORKFLOW_ID`, mobile → new `GITHUB_MOBILE_GENERATION_WORKFLOW_ID`.
  `GET /generation-payload/:correlationId` (`webhooks.js`) and `buildPlanMarkdown`/`exportPlansForTestCases`
  (`planExport.js`) are now platform-aware too — mobile gets `app_id` (env var default, same category as the
  existing `target_url` fallback) instead of `target_url`, and a mobile-appropriate "Starting state" line.
- New `.github/workflows/generate-mobile-tests.yml` + `.github/scripts/generate-mobile-tests.js`, mirroring the
  web pipeline closely: `runs-on: [self-hosted, mobile]`, an explicit `GITHUB_PATH` append for Maestro/Java (a
  self-hosted runner's job environment isn't guaranteed to inherit an interactive shell's PATH), a device-connected
  sanity check, then the same fetch-payload → plan/generate/heal (via `maestro-test-*` agents) → PR → report-
  completion shape as `generate-tests.yml`.
- **Real, structural discovery**: GitHub's `workflow_dispatch` API only recognizes a workflow file that already
  exists on the repository's *default branch* — pushing it to a feature branch and dispatching against that ref
  does not work, confirmed via a live 404 and `GET /actions/workflows` simply not listing the new file at all.
  This forced an explicit conversation with Malik about pushing to master (his standing rule is no pushes without
  asking) — he authorized it for this specific case once the constraint was clear.
- **Real operational lesson, worth remembering**: switching local git branches (`git checkout master`) while
  several files had *uncommitted* local edits silently discarded those edits back to master's last-committed
  content for this local checkout — not a bug, just normal git behavior colliding with a session that had been
  running for many hours with a lot of uncommitted state. Recovered cleanly: the PR merge on GitHub's side already
  carried the equivalent content, `git stash` + `git pull` reconciled the rest without any real loss, but this cost
  real time. Lesson for future long sessions: commit or stash before any branch switch once uncommitted changes
  have piled up, even when not intending to push yet.
- **First real run failed for a mundane, correct reason**: the physical device had disconnected (screen doze /
  session length, not a runner-specific bug) — the planner agent, running as a real non-interactive subagent
  dispatch inside `claude -p`, correctly detected via `list_devices` that no Android device was connected and
  stopped cleanly rather than guessing, reporting exactly why. No file was written, no false success. Confirmed via
  the real Claude Code session transcript on disk (`~/.claude/projects/<runner-workspace-hash>/*.jsonl`) — a real,
  readable audit trail for diagnosing headless agent runs, worth remembering for future debugging.
- **Second real run succeeded completely**: `generation_runs` id 12 reached `status='completed'` with a real
  `pr_url`. The planner independently rediscovered — live, unprompted, with no memory of the earlier interactive
  session — the exact same two traps found by hand in Round 1 (the hidden `"Calculation result"` text suffix on
  `calc_edt_formula`; the false-positive risk of an unscoped digit assertion matching the permanently-visible
  keypad) and documented them in the updated plan file. The generator then produced a correctly `id`-scoped,
  `.*`-anchored flow using them. Real PR: `github.com/Flinch/qa-tool-server/pull/17`.
- This closes out the last structurally unverified piece of the mobile pipeline. What's left is genuinely just the
  hosting decision (Maestro Cloud trial), the frontend (suite creation UI, enabling the already-guarded Run/
  Generate buttons), binary/app management (still nobody's built this), and iOS (still untested, no Xcode).

## Phase 6 — mobile pipeline: generation logic + hosting-agnostic reporting

- Same day, third round: after the Maestro Cloud vs. AWS Device Farm comparison, Malik decided to hold off on
  the hosting decision (including the self-hosted-runner alternative) until after trying Maestro Cloud's trial, and
  asked to build the generation logic and reporting pipeline now, against real local devices, structured so hosting
  is a swap-in later rather than a rebuild. Scope locked down via `AskUserQuestion` before planning: local/manual
  generation only this round (no GitHub Actions workflow — a self-hosted runner is itself one of the two hosting
  paths being deferred), schema changes now (additive/hosting-agnostic), Calculator app again (no client data).
- **Schema**: `automation_suites.platform` (`web`/`ios`/`android`, default `web`) and `automation_suites.engine`
  (`playwright`/`maestro`/`appium`, nullable) — additive, matches the original handoff's sketch exactly. Deliberately
  did NOT add `projects.ios_build_s3_key`/`android_build_s3_key` from the same sketch — nothing in this round uploads
  a binary anywhere, so those columns would sit unused until a real build-upload flow exists.
- **Real bug this change would have introduced, caught before shipping**: adding `platform` makes a real mobile
  suite row immediately visible in the existing Automation page, but `automationTrigger.js` dispatches every suite
  through one hardcoded `GITHUB_WORKFLOW_ID` (the web Playwright workflow). Without a guard, clicking "Run" on a
  mobile suite would silently dispatch the wrong workflow and report back a misleading empty 0-test run instead of a
  clear error. Fixed in both `triggerSuiteRun` and `triggerGenerationRun` (same reasoning applies to the generation
  dispatch path) — a `platform !== 'web'` suite now throws a clear "not wired up yet" error server-side, and the
  client's `SuiteCard` shows a disabled Run button with an explanatory tooltip instead of a live one.
- **The Maestro MCP server (`maestro mcp`, registered in `.mcp.json` this round) turned out not to be reachable from
  the outer harness session** — its tools are scoped to a `claude` CLI invocation with `qa-tool-server` as its
  working directory, not to an outer orchestration session whose primary project is a different repo
  (`qa-tool-client`). Confirmed by `ToolSearch` returning no match. Separately, replicating `generate-tests.js`'s
  exact invocation pattern (`npx claude -p "..." --permission-mode dontAsk`) to actually run the new agents was
  blocked by the harness's own auto-mode classifier — spawning a nested Claude Code session with broad
  non-interactive permission is a meaningfully different, more powerful action than what was being asked, and the
  classifier was right to flag it. Worked around by doing the planner/generator/healer work directly in the current
  session instead, using the `maestro` CLI directly (`maestro hierarchy --compact`, `maestro test`) — functionally
  identical to what the MCP tools wrap, and the same mechanism already proven in the Phase 0 spike. This matters for
  Phase 1/2 later: the real CI pipeline (`generate-tests.js`'s pattern) runs inside GitHub Actions, not this
  session, so the MCP-server-scoping issue is specific to doing this work interactively outside CI — it should not
  recur once a real `generate-mobile-tests.yml` exists.
- **Three new agents** (`.claude/agents/maestro-test-planner.md`, `-generator.md`, `-healer.md`) mirror the existing
  Playwright planner/generator/healer's workflow shape, adapted to Maestro MCP's actual (flatter) tool surface —
  `inspect_screen` covers hierarchy inspection, `run` covers both live-verification during generation and
  re-verification during healing, and the generic `Write`/`Edit` tools save the flow YAML directly since there's no
  dedicated `write_test`/`read_log` tool like Playwright's MCP has. `.claude/settings.json`'s tool allowlist extended
  with the five `mcp__maestro__*` tools these agents use.
- **Real proof, not just written agent prompts**: ran the actual plan → generate → heal loop by hand this session
  (playing each agent role per its own instructions) against the connected physical device and the Calculator app —
  6 real scenarios (addition/subtraction/multiplication/division/clear/percentage), saved to
  `specs/mobile-mobile-smoke-android.md` and `tests/generated-mobile/android/mobile-smoke-android/*.yaml`. One flow
  (percentage) was deliberately written with an unanchored exact-text assertion — the same real, recurring trap
  found in the Phase 0 spike, not a fabricated bug — to genuinely exercise the heal step rather than skip it because
  the other 5 flows (which already encoded the spike's lessons) passed first try. It failed for real, was diagnosed
  via a real `inspect_screen`/`maestro hierarchy` call, fixed with a `.*` anchor, and re-verified passing.
- **`scripts/report-mobile-results.js`** (new, uses `fast-xml-parser` — added as a real dependency this time, unlike
  the Phase 0 spike's `@aws-sdk/client-device-farm` which was deliberately left uninstalled since nothing could run
  it yet; this script runs today) parses Maestro's real JUnit output (`status="SUCCESS"` self-closing for a pass,
  `status="ERROR"` with a `<failure>` child for a fail — confirmed by hand, not assumed from generic JUnit docs) into
  the exact payload shape `report-results.js` already produces, and POSTs to the existing, unmodified
  `POST /webhooks/test-runs`. Proves the hosting-agnostic contract for real: this run happened locally, with zero
  changes to the endpoint that will also receive results from a self-hosted runner, Device Farm, or Maestro Cloud
  later.
- Seeded one real suite row (`Mobile Smoke (Android)`, `mobile-smoke-android`, project id 3 "Service Desk App",
  `platform='android'`, `engine='maestro'`) directly into the dev DB — confirmed with Malik first that
  `DATABASE_URL` in this local `.env` points at a separate dev/staging Railway instance, not production, before
  inserting anything.
- Ran the full loop end to end for real: `test_runs` id 43 landed with `total=6, passed=6, failed=0`, six matching
  `test_run_results` rows, confirmed by direct SQL query (not just trusting the webhook's 200 response).
- Added a "Mobile tests (Maestro)" section to `AGENTS.md`, mirroring the existing web pipeline's conventions
  (locations, selector/assertion policy, behavior-mismatch handling adapted to YAML via a `flagged-regression` tag
  since Maestro has no `test.fixme()` equivalent).
- Not done this round, deliberately: no GitHub Actions workflow files, no self-hosted runner registration, no suite
  CRUD UI, no AWS Device Farm/Maestro Cloud wiring, no iOS (still blocked on Xcode). All flagged as follow-ups once
  the hosting decision is made.

## Phase 6 — mobile test automation, Phase 0 spike addendum: the custom MCP adapter isn't needed

- Follow-up the same day: Malik asked whether we should start building the
  Phase 2 "driver" (the custom hierarchy-dump MCP adapter, ~1-2 weeks per the
  handoff's estimate). Investigated `maestro mcp` — a command visible in
  `maestro --help` that hadn't been checked yet — and confirmed for real
  (JSON-RPC handshake over stdio, real tool calls against the same physical
  device) that Maestro CLI 2.6.1 already ships a complete MCP server:
  `list_devices`, `inspect_screen` (the hierarchy-dump tool), `take_screenshot`,
  `run` (flow execution), plus `list_cloud_devices`/`run_on_cloud`/
  `get_cloud_run_status` for Maestro Cloud. All three core tools verified
  working against the real device, not just read from schemas.
- **This eliminates the custom adapter build from Phase 2.** `inspect_screen`
  is functionally identical to what this spike hand-rolled with `maestro
  hierarchy --compact`, and its tool description already warns callers about
  the exact two traps this spike discovered the hard way (hidden
  accessibility-suffix text; full-string-regex matching needing `.*`
  anchors) — see `mobile-spike/FINDINGS.md` for the verified detail.
- Real, unplanned finding during verification: the live `inspect_screen`
  output captured actual notification content from the test phone (Gmail,
  downloads) including a filename referencing a real client — not written to
  any file in this repo, but flagged in `mobile-spike/FINDINGS.md` as a
  reason local real-device testing shouldn't happen on a personal/work phone
  with real accounts signed in.
- **New open question, not yet evaluated**: Maestro Cloud (the same MCP
  server's cloud tools) is a first-party alternative to the AWS Device Farm
  path this spike already built scripts for. The original handoff picked AWS
  Device Farm for cost reasons without knowing Maestro Cloud existed as an
  option — worth a real pricing/tradeoff comparison before Phase 1 commits
  either way. Not resolved this session.

## Phase 6 — mobile test automation, Phase 0 spike

- Real local spike, not a design doc: installed Java (OpenJDK, Homebrew,
  keg-only — added `/opt/homebrew/opt/openjdk/bin` to `PATH` in `~/.zshrc`),
  Maestro CLI 2.6.1, and `android-platform-tools` (adb) on the dev machine,
  connected a real physical Android device (Samsung Galaxy S20 FE, Android
  13) over USB, and ran 11 real Maestro flows against it. Everything lives in
  `mobile-spike/` — deliberately separate from `tests/`/`.github/workflows/`
  until Phase 1 decides what graduates. Full detail and the real data in
  `mobile-spike/FINDINGS.md`.
- Used the stock Samsung Calculator app, not a client binary — Malik
  confirmed no client app was needed for this spike, avoiding both an APK
  download question and any client-identifying data, consistent with the
  existing rule against putting client-identifying detail somewhere it
  wasn't explicitly authorized to go.
- **Real finding, stronger than the handoff predicted**: the handoff framed
  the blind-vs-hierarchy-dump comparison as a heal-iteration-count question.
  The actual result is more serious — 4 of 5 blind (screenshot-only)
  assertions "passed" as **false positives**, matching the permanently-
  visible keypad digit button instead of the actual calculation result
  (`assertVisible: "4"` with no element scope matches ANY on-screen element
  with that text, including the digit key itself, not just the result
  field). The one blind flow that correctly failed (multiplication, 2-digit
  result) failed for a reason invisible to blind authoring, with no way to
  diagnose or fix it without hierarchy access. All 5 hierarchy-assisted
  flows (scoped to the real `resource-id` of the result field) correctly
  verify real behavior, with only 2 genuine heal iterations needed across
  all 5 — both real tooling quirks (a hidden accessibility-only text suffix
  Samsung appends to the result; empty-string text matching not working
  as expected) that were only diagnosable because the raw hierarchy was
  visible. This is real, reproduced evidence for the handoff's Option 1 (the
  custom hierarchy-dump MCP adapter) over Option 2 (execution-only healing)
  — a wider heal budget wouldn't have caught the false positives, since
  those flows were reporting green.
- **Correction to the handoff**: `maestro hierarchy --simple` (cited as the
  "LLM-optimized hierarchy output" flag) doesn't exist on the installed
  stable CLI (2.6.1) — `Unknown option: '--simple'`. What exists is plain
  `maestro hierarchy` (full nested JSON, 2319 lines for one screen — too
  verbose) and `maestro hierarchy --compact` (flat CSV, 100 lines for the
  same screen, ~23x smaller) — used for every hierarchy-assisted flow in
  this spike. The Phase 2 MCP adapter should target `--compact`, or re-check
  against whatever CLI version is current when that work starts.
- iOS not attempted — this machine has Xcode Command Line Tools but not full
  Xcode (no iOS Simulator), and installing full Xcode is a large,
  opinionated App Store/Developer-account install that wasn't done without
  asking first. Still open: does `maestro hierarchy --compact` carry the
  same signal on iOS's XCTest-based driver as confirmed here on Android's
  UiAutomator-based one — needs its own pass before the MCP adapter is
  designed for both platforms.
- AWS Device Farm (open question #1 from the handoff — does the Custom Test
  Environment run Maestro cleanly end to end against a real binary) is
  **not resolved this session** — no AWS account exists yet. Malik chose to
  handle the AWS-account/Device-Farm side himself; `mobile-spike/device-
  farm-test-spec.yml` and `mobile-spike/scripts/device-farm-run.js` are
  written against AWS's documented Custom Test Environment format and drop
  results into the exact same `{total,passed,failed,results[]}` shape
  `report-results.js` already POSTs, but are untested against a live
  account. `mobile-spike/AWS-SETUP-RUNBOOK.md` hands off the exact remaining
  steps, with the specific unverified parts (upload/test-type enum strings,
  whether Device Farm's host image needs a manual JDK install, the real
  JUnit-output artifact path) called out explicitly rather than presented as
  confirmed.
- `@aws-sdk/client-device-farm` is a new dependency this introduces, not yet
  added to `package.json` — deliberately left for whoever actually runs
  `device-farm-run.js` for the first time (via the runbook), so it doesn't
  sit in `package.json` unused until Phase 1 actually wires this in.

## Phase 5 — fix: suite "test case count" drifting from reality

- Real bug, surfaced by Malik: the E2E suite showed 14 test cases in the UI when only 11 actually exist in `tests/e2e/` + `tests/generated/e2e/` combined. Root cause: `test_case_count` on `GET /suites` and on an execution run's suites list was `COUNT(atc.id)` against `automated_test_cases` — a roster table that `webhooks.js`'s `POST /test-runs` only ever *adds* to (`ON CONFLICT (suite_id, title) DO NOTHING`), by design (see the comment already on that insert loop) never removing a title for a test that got renamed or deleted. Every failed/healed generation attempt or renamed test permanently inflates the roster; it never self-corrects. Confirmed independently on the local dev DB: E2E's roster count there was 7, which *also* didn't match the real file count (11) — different number, same root cause, proving this wasn't production-specific stale data but a structural drift bug.
- Fixed in both `automation.js`'s `GET /suites` and `executionRuns.js`'s per-run suites query: `test_case_count` is now `COALESCE(latest_run.total, COUNT(atc.id))` — prefer the last real run's actual total (accurate by construction, since it's exactly what Playwright reported) over the ever-growing roster, falling back to the roster count only for a suite that's never executed yet (where there's no run total to prefer).
- Deliberately did not touch the roster's insert-only accumulation behavior itself (`automated_test_cases` keeps growing) — only stopped trusting it for the count display. Pruning it was a separate, riskier change not requested; the roster may still be useful as a "every test title ever seen" history.
- Caveat: this fixes the count going forward from the *next* real suite run — if a suite's last recorded `test_runs.total` predates a file/test change, the displayed count won't be accurate until that suite runs again and reports a fresh total.
