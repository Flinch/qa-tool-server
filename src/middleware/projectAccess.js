import { query } from '../db/pool.js'

// For client role, verifies they're a member of the project named in the URL
// (:id param, requires mergeParams on the router). Staff (qa_engineer/admin)
// pass through unchecked — mirrors assertProjectAccess in routes/projects.js.
export async function requireProjectAccess(req, res, next) {
  if (req.userRole === 'client') {
    const { rows } = await query(
      `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2`,
      [req.params.id, req.userId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  }
  next()
}
