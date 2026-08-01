// Archives a test case once it has NO remaining requirement coverage — same
// union testCases.js's GET / already computes for its linked_requirements
// column, so "orphaned" here means the exact same thing it already visibly
// means there. Deliberately only called at the moment a link is removed
// (never as a standalone sweep), so it's a transition-triggered event, not
// a retroactive rule — a test case that already has zero links today is
// untouched unless/until something actively unlinks it further.
export async function archiveIfOrphaned(db, projectId, testCaseId) {
  const { rows } = await db.query(
    `SELECT 1
     FROM (
       SELECT test_case_id FROM requirement_test_cases WHERE test_case_id=$1
       UNION
       SELECT test_case_id FROM flow_requirements WHERE test_case_id=$1
     ) links`,
    [testCaseId]
  )
  if (rows.length > 0) return false

  const { rowCount } = await db.query(
    `UPDATE test_cases SET archived_at=NOW() WHERE id=$1 AND project_id=$2 AND archived_at IS NULL`,
    [testCaseId, projectId]
  )
  return rowCount > 0
}

// Unlinks every test case from a requirement that's being removed — both
// regular coverage (requirement_test_cases) AND critical-flow coverage
// (flow_requirements, since a flow can span multiple requirements, only
// THIS requirement's link is dropped, not the flow's other links) — and
// archive-checks each affected test case. Otherwise a removed requirement's
// test cases just keep sitting there silently linked to a dead requirement
// forever, invisible to the Test Cases page's requirement column, the
// diff-based generation review, and "Generate critical flows" alike (all
// three only ever look at ACTIVE requirements). Called wherever a
// requirement transitions to status='removed': POST /apply-diff's removed
// loop and PATCH /:reqId's manual delete.
export async function unlinkRequirementTestCases(db, projectId, requirementId) {
  const { rows: rtcRows } = await db.query(
    `DELETE FROM requirement_test_cases WHERE requirement_id=$1 RETURNING test_case_id`,
    [requirementId]
  )
  const { rows: frRows } = await db.query(
    `DELETE FROM flow_requirements WHERE requirement_id=$1 RETURNING test_case_id`,
    [requirementId]
  )
  const testCaseIds = new Set([...rtcRows, ...frRows].map(r => r.test_case_id))
  const archivedIds = []
  for (const testCaseId of testCaseIds) {
    if (await archiveIfOrphaned(db, projectId, testCaseId)) archivedIds.push(testCaseId)
  }
  return archivedIds
}
