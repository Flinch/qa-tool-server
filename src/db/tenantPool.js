// Resolves a tenant id to the pg.Pool holding that tenant's data.
//
// REAL PER-TENANT ROUTING (Phase A, Part 5 cutover): each tenant now has its
// own physical database, named in tenants.db_name (bp_tenant_<slug>). A
// distinct pg.Pool is created lazily per tenant and cached — dozens of
// tenants at most, no eviction needed yet.
//
// This was the identity resolver until the real cutover ran: every tenant
// pointed at the same shared legacy database (tenants.db_name held a
// 'legacy-shared-<id>' placeholder) so the whole routing interface
// (this file, tenantAccess.js, every req.db.query() call site) could be
// built and proven against real traffic first, with zero risk of actually
// misrouting anything, before a second physical database ever existed.
import pg from 'pg'
import { getTenantMeta } from './tenantRegistry.js'

const tenantPools = new Map() // tenantId -> pg.Pool

export async function resolveTenantPool(tenantId) {
  const tenant = await getTenantMeta(tenantId)
  if (!tenant) return null
  if (tenant.status !== 'active') return null

  if (tenantPools.has(tenant.id)) return tenantPools.get(tenant.id)
  const p = new pg.Pool({
    connectionString: buildTenantConnectionString(tenant.db_name),
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  })
  tenantPools.set(tenant.id, p)
  return p
}

// Same Postgres instance, different logical database — swaps the path
// (database name) on the base connection string, keeps host/port/creds.
// Exported: scripts/provisionTenant.js and scripts/migrateTenantData.js both
// need to connect to a brand-new tenant database directly, before it's
// registered 'active' in the control plane (so resolveTenantPool above
// can't resolve it for them yet — this is the one place that's fine, since
// those scripts run by hand, not through a live request).
export function buildTenantConnectionString(dbName) {
  const url = new URL(process.env.DATABASE_URL)
  url.pathname = `/${dbName}`
  return url.toString()
}
