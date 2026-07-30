import { pool } from './pool.js'
import { CONTROL_PLANE_SCHEMA_SQL } from './schema/controlPlaneSchema.js'
import { TENANT_SCHEMA_SQL } from './schema/tenantSchema.js'
import { listAllTenants } from './tenantRegistry.js'
import { resolveTenantPool } from './tenantPool.js'

// Applies the tenant schema to one tenant's database. Accepts either a
// tenant id (looked up and resolved to a pool) or an already-resolved pool
// directly — the latter is what scripts/provisionTenant.js and
// scripts/migrateTenantData.js use right after CREATE DATABASE, before that
// tenant is even registered as 'active' in the control plane (and so before
// resolveTenantPool would return anything for it). Exported so this is the
// one place tenant schema SQL is ever applied.
export async function migrateTenant(tenantIdOrPool) {
  const db = typeof tenantIdOrPool === 'number' ? await resolveTenantPool(tenantIdOrPool) : tenantIdOrPool
  await db.query(TENANT_SCHEMA_SQL)
}

async function migrate() {
  console.log('Migrating control plane...')
  await pool.query(CONTROL_PLANE_SCHEMA_SQL)

  const tenants = await listAllTenants()
  console.log(`Migrating ${tenants.length} tenant(s)...`)
  for (const t of tenants) {
    // resolveTenantPool only ever resolves a pool for status='active'
    // tenants (the right default for normal request handling — see
    // tenantPool.js). A tenant sitting in 'provisioning' or 'suspended'
    // just gets skipped here rather than crashing the whole deploy's
    // migration run over one row: 'provisioning' tenants get their schema
    // applied directly by provisionTenant.js instead (passing an already-
    // resolved pool to migrateTenant, not going through this id-based
    // path), and 'suspended' intentionally doesn't get touched while paused.
    const db = await resolveTenantPool(t.id)
    if (!db) {
      console.log(`  tenant ${t.id} (${t.slug}) — status='${t.status}', skipping`)
      continue
    }
    console.log(`  tenant ${t.id} (${t.slug})...`)
    await migrateTenant(db)
  }

  console.log('Migrations complete.')
  await pool.end()
}

// Guarded like scripts/provisionTenant.js: this module is imported by other
// scripts purely for the migrateTenant export (provisionTenant.js,
// migrateTenantData.js). Without this check, importing it for that export
// would ALSO run the full migrate() sweep — including pool.end() — as an
// unwanted side effect of the import itself. Caught live: it's what caused
// "Called end on pool more than once" when provisionTenant.js first ran.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch(err => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
}
