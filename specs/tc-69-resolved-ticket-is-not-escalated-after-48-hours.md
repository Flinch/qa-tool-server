# TC-69: Resolved ticket is not escalated after 48 hours

<!-- source: qa-tool test case 69 | type: functional -->
<!-- automation rationale: Verifying the absence of escalation for resolved tickets is deterministic and scriptable with a clear pass/fail assertion on the unchanged priority value. -->

<!-- BEHAVIOR MISMATCH (live-verified 2026-07-28 against https://service-desk-roan.vercel.app):
     expected an escalation mechanism that bumps priority on unresolved tickets after 48h
     (and is suppressed for resolved tickets, per this scenario).
     actual: no escalation feature exists anywhere in the app. There is no escalate button,
     no admin/SLA setting that triggers escalation (Admin > SLA Settings only edits
     target-hours-per-priority, used for display and the .overdue-row highlight), and no API
     endpoint — the app is a fully client-side in-memory SPA that makes zero XHR/fetch calls
     during ticket CRUD. A full-text search of the deployed JS bundle for "escalat*" returns
     zero matches. Steps 3-4 (simulate 48h / trigger escalation) are NOT verifiable or
     automatable. Corroborating: seed ticket TKT-004 (Medium, Resolved, created ~2 days ago,
     i.e. already past 48h) still shows priority Medium — consistent with no escalation
     existing for any ticket, not with escalation being correctly suppressed for resolved ones. -->

## Scenario: TC-69 — Resolved ticket is not escalated after 48 hours

Starting state: authenticated (storageState), on the dashboard.

<!-- NOTE (live-verified): Priority combobox options are Critical/High/Medium/Low, with 'Medium'
     as the default. createTicket(page) hardcodes Priority='High', so a Medium ticket needs an
     explicit selectOption('Medium'). "Resolved" is reached via the ticket detail page's
     "Workflow Status" stepper — a linear one-step-at-a-time path Open -> In Progress ->
     Waiting on Customer -> Resolved -> Closed, advanced with buttons named "Move to: <next>"
     (the resolve action is button "Move to: Resolved" from the Waiting on Customer state). -->

Steps:
1. Create a ticket with a priority of 'Medium' (select 'Medium' in the Priority combobox before submitting)
2. Open the ticket and advance the Workflow Status stepper to 'Resolved' (Open -> In Progress -> Waiting on Customer -> Resolved via the "Move to: <next>" buttons); confirm the header badge reads 'Medium | Resolved'
3. Simulate or wait for 48 hours to elapse since ticket creation — NOT VERIFIABLE: no time-simulation control exists (see BEHAVIOR MISMATCH above)
4. Trigger or wait for the escalation process to run — NOT VERIFIABLE: no escalation mechanism exists (see BEHAVIOR MISMATCH above)
5. Retrieve the ticket's current priority via the UI

Expect: The resolved ticket's priority remains 'Medium' and is not escalated. NOTE: this outcome cannot be genuinely exercised because the app implements no escalation feature and no way to simulate 48 hours elapsing; only ticket creation with Medium priority and the transition to Resolved are verifiable. The generator should write this as test.fixme() with a // POSSIBLE REGRESSION: (feature-not-implemented) comment per AGENTS.md, asserting no weaker substitute for the escalation outcome.
