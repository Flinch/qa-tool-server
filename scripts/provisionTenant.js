// CLI-only tenant provisioning (Phase A, Part 5). Run by hand when
// onboarding a new client:
//
//   node scripts/provisionTenant.js --name "Acme Corp" --client-name "Acme" --description "..."
//
// Deliberately NOT a live HTTP route. Creating a real Postgres database
// needs a database-creation-capable credential (PROVISIONING_DATABASE_URL),
// and that credential should never live on the always-on web server
// process — see "Phase A: DB-per-client multi-tenancy" for why. This script
// is the only place that credential is ever used, for the few seconds it
// takes to run.
import 'dotenv/config'
import pg from 'pg'
import { query as controlQuery, pool as controlPool } from '../src/db/pool.js'
import { migrateTenant } from '../src/db/migrate.js'
import { buildTenantConnectionString } from '../src/db/tenantPool.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    const value = (next === undefined || next.startsWith('--')) ? true : argv[++i]
    out[key] = value
  }
  return out
}

function slugify(name) {
  return String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

async function uniqueSlug(name) {
  const base = slugify(name) || 'client'
  let slug = base
  let n = 2
  while (true) {
    const { rows } = await controlQuery(`SELECT 1 FROM tenants WHERE slug=$1`, [slug])
    if (!rows[0]) return slug
    slug = `${base}-${n++}`
  }
}

export async function provisionTenant({ name, clientName, description, createdByUserId = null, skipSeed = false }) {
  if (!name?.trim()) throw new Error('name is required')

  const provisioningUrl = process.env.PROVISIONING_DATABASE_URL
  if (!provisioningUrl) {
    console.warn(
      'PROVISIONING_DATABASE_URL is not set — falling back to DATABASE_URL for this run. ' +
      'Fine for now if that role already has CREATEDB (Railway\'s default user usually does), ' +
      'but set up a narrower, separate provisioning credential per "Phase A" Part 7 when you get to it.'
    )
  }

  const slug = await uniqueSlug(name)
  const dbName = `bp_tenant_${slug.replace(/-/g, '_')}`

  console.log(`Registering tenant "${name}" (slug=${slug}, db=${dbName})...`)
  const { rows } = await controlQuery(
    `INSERT INTO tenants (slug, db_name, status, created_by) VALUES ($1,$2,'provisioning',$3) RETURNING id`,
    [slug, dbName, createdByUserId]
  )
  const tenantId = rows[0].id

  console.log(`Creating database "${dbName}"...`)
  const admin = new pg.Pool({ connectionString: provisioningUrl || process.env.DATABASE_URL, max: 1 })
  try {
    // Postgres doesn't allow parameterized identifiers here — dbName is
    // server-generated (slugified + underscored) above, never raw user
    // input, so this is safe from injection despite the string interpolation.
    await admin.query(`CREATE DATABASE "${dbName}"`)
  } finally {
    await admin.end()
  }

  console.log('Running tenant schema migrations...')
  const tenantPool = new pg.Pool({ connectionString: buildTenantConnectionString(dbName) })
  try {
    await migrateTenant(tenantPool)

    // Forces the new tenant's sole projects row to share its id with the
    // tenant record above — see "tenant id == project id" in the Phase A
    // plan. This is the only place that trick needs to happen.
    await tenantPool.query(
      `INSERT INTO projects (id, name, client_name, description, created_by)
       OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, name.trim(), clientName?.trim() || null, description?.trim() || null, createdByUserId]
    )
    await tenantPool.query(`SELECT setval(pg_get_serial_sequence('projects','id'), $1, true)`, [tenantId])

    if (!skipSeed) {
      await tenantPool.query(
        `INSERT INTO features (project_id, name, created_by) VALUES ($1,'General',$2)`,
        [tenantId, createdByUserId]
      )
      // Every project starts with somewhere for "Generate automated tests"
      // to target — a brand-new project with zero suites was a real dead
      // end (see automation.js's POST /suites, added alongside this so
      // staff can add more as needs grow). Web + no engine (implies
      // Playwright), same convention every existing web suite uses.
      await tenantPool.query(
        `INSERT INTO automation_suites (project_id, name, slug, platform) VALUES ($1,'E2E Critical Flow','e2e-critical-flow','web')`,
        [tenantId]
      )
    }
  } finally {
    await tenantPool.end()
  }

  await controlQuery(`UPDATE tenants SET status='active', updated_at=NOW() WHERE id=$1`, [tenantId])

  console.log(`Tenant ${tenantId} (${slug}) is active.`)
  return { id: tenantId, slug, dbName }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.name) {
    console.error('Usage: node scripts/provisionTenant.js --name "Client Name" [--client-name "..."] [--description "..."]')
    process.exit(1)
  }
  try {
    await provisionTenant({
      name: args.name,
      clientName: args['client-name'],
      description: args.description,
    })
  } finally {
    await controlPool.end()
  }
}

// Only run as a CLI entrypoint — importable for scripts/migrateTenantData.js
// to reuse without triggering main()'s argv parsing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Provisioning failed:', err)
    process.exit(1)
  })
}
