// Control-plane reads: who can see which tenants, and what a tenant's
// routing metadata is. Always queries the control-plane pool (`pool.js`) —
// never a tenant's own pool, which is what tenantPool.js resolves.
import { query } from './pool.js'

export async function getTenantMeta(tenantId) {
  const { rows } = await query(
    `SELECT id, slug, db_name, status FROM tenants WHERE id=$1`,
    [tenantId]
  )
  return rows[0] || null
}

// Staff (qa_engineer/admin) see every active tenant, same as today's "staff
// see all projects" behavior. Client-role users see only tenants they're
// explicitly a member of, via tenant_members (replaces project_members).
export async function listVisibleTenants(userId, role) {
  if (role === 'client') {
    const { rows } = await query(
      `SELECT t.* FROM tenants t
       JOIN tenant_members tm ON tm.tenant_id = t.id
       WHERE tm.user_id=$1 AND t.status='active'
       ORDER BY t.created_at`,
      [userId]
    )
    return rows
  }
  const { rows } = await query(
    `SELECT * FROM tenants WHERE status='active' ORDER BY created_at`
  )
  return rows
}

// Every non-archived tenant — used by migrate.js to know which tenant DBs
// need schema migrations applied. Includes 'provisioning' (a tenant mid-
// setup should still pick up schema changes) and 'suspended' (paused, not
// gone), excludes 'archived' (retired, don't touch).
export async function listAllTenants() {
  const { rows } = await query(
    `SELECT * FROM tenants WHERE status != 'archived' ORDER BY id`
  )
  return rows
}
