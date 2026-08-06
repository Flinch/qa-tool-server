import { Router } from 'express'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { requireTenantAccess } from '../middleware/tenantAccess.js'

const router = Router({ mergeParams: true })
router.use(requireAuth)
router.use(requireTenantAccess)

const staffOnly = requireRole('qa_engineer', 'admin')
const VALID_TYPES = ['bugs', 'execution_test_cases']

// GET / — every saved view for the project, shared team-wide. Open to
// clients too (unlike creating/deleting one) since Views is a browsing
// destination for both roles, same access shape Reports had before it.
router.get('/', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM saved_views WHERE project_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    )
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /:viewId — single view. Used by BugsPage/ExecutionRunDetailPage's
// ?viewId= readers and by ViewRedirectPage's latest-run resolution.
router.get('/:viewId', async (req, res) => {
  try {
    const { rows } = await req.db.query(
      `SELECT * FROM saved_views WHERE id=$1 AND project_id=$2`,
      [req.params.viewId, req.params.id]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.post('/', staffOnly, async (req, res) => {
  const { name, type, filters } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid view type' })

  try {
    const { rows } = await req.db.query(
      `INSERT INTO saved_views (project_id, name, type, filters, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, name.trim(), type, JSON.stringify(filters || {}), req.userId]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.delete('/:viewId', staffOnly, async (req, res) => {
  try {
    const { rowCount } = await req.db.query(
      `DELETE FROM saved_views WHERE id=$1 AND project_id=$2`,
      [req.params.viewId, req.params.id]
    )
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' })
    res.status(204).end()
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
