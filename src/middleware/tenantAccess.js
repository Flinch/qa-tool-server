// Replaces middleware/projectAccess.js. Two jobs where that file only did
// one: (1) same membership check as before, now against the control-plane
// tenant_members table instead of project_members, staff still bypassing
// entirely; (2) resolve and attach the tenant's own pool as req.db, which
// every route handler now queries against instead of the old global pool
// import — that's the piece that makes DB-per-tenant isolation real instead
// of just a routing label.
import { query as controlQuery } from '../db/pool.js'
import { resolveTenantPool } from '../db/tenantPool.js'

export async function requireTenantAccess(req, res, next) {
  const tenantId = req.params.id
  try {
    if (req.userRole === 'client') {
      const { rows } = await controlQuery(
        `SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`,
        [tenantId, req.userId]
      )
      if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    }
    const db = await resolveTenantPool(tenantId)
    if (!db) return res.status(404).json({ error: 'Not found' })
    req.db = db
    req.tenantId = Number(tenantId)
    next()
  } catch (e) {
    next(e)
  }
}
