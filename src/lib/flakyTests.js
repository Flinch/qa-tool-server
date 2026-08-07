// A test is flaky if, across its last 5 real (non-diagnostic) suite runs,
// it's flipped between passed and failed at least once. Same tr.scope=
// 'suite' exclusion used throughout automation.js/projects.js so a
// diagnostic re-run/heal dispatch never counts as real run history.
// Needs at least 3 real runs before it's judged — one flip in only 1-2 runs
// isn't enough signal to call a test flaky rather than just recently fixed
// or recently broken.
// `platform` scopes to one platform's suites (automation_suites.platform
// already has web/ios/android granularity) — used by the per-platform
// Quality Score breakdown, where a flaky iOS test shouldn't move the web
// score and vice versa.
export async function computeFlakyTests(db, projectId, { limit = 10, platform = null } = {}) {
  const { rows } = await db.query(`
    WITH ranked AS (
      SELECT trr.test_title, tr.suite_id, s.name AS suite_name, trr.status, tr.completed_at,
        ROW_NUMBER() OVER (PARTITION BY trr.test_title, tr.suite_id ORDER BY tr.completed_at DESC) AS rn
      FROM test_run_results trr
      JOIN test_runs tr ON tr.id = trr.test_run_id
      JOIN automation_suites s ON s.id = tr.suite_id
      WHERE tr.project_id = $1 AND tr.scope = 'suite'
        AND ($3::text IS NULL OR s.platform = $3)
    )
    SELECT test_title, suite_name,
      COUNT(*)::int AS runs_considered,
      COUNT(*) FILTER (WHERE status = 'passed')::int AS passed_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
    FROM ranked
    WHERE rn <= 5
    GROUP BY test_title, suite_name
    HAVING COUNT(*) >= 3 AND COUNT(DISTINCT status) > 1
    ORDER BY failed_count DESC
    LIMIT $2
  `, [projectId, limit, platform])
  return rows
}
