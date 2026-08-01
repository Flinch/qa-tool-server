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
