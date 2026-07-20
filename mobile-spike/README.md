# Mobile test automation — Phase 0 spike

Standalone spike directory, deliberately separate from `tests/` and
`.github/workflows/` — nothing here is wired into the real pipeline yet.
See `claude-code-handoff-phase6.md` (in Malik's Documents) for the full
initiative context, and `DECISIONS.md` at the repo root for the summary
entry.

- **`FINDINGS.md`** — start here. The real result of the blind-vs-hierarchy-
  dump generation comparison, and what it means for the Phase 2 MCP adapter
  decision.
- **`flows/`** — the 11 real Maestro flows run against a physical Android
  device for this spike (`smoke-add.yaml` plus 5 blind + 5 hierarchy-
  assisted comparison flows).
- **`hierarchy-dumps/`** — real `maestro hierarchy` output captured during
  the spike, for reference.
- **`device-farm-test-spec.yml`**, **`scripts/device-farm-run.js`** — written
  but not yet run against a live AWS account. See `AWS-SETUP-RUNBOOK.md`.
- **`AWS-SETUP-RUNBOOK.md`** — what Malik needs to do (AWS account, IAM,
  device pool) to close out the one open question this spike couldn't
  resolve locally.
