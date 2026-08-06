// Creates a customer -> project -> N activities chain via the OrangeHRM time-tracking API
// (POST .../time/customers, then .../time/projects, then .../time/project/{id}/activities),
// reusing the session already established by apiLogin on the same `request` context. Reuse
// this for any timesheet-entry scenario that needs one or more distinct project/activity
// combinations to record line items against, instead of re-deriving and re-verifying the same
// POST chain per spec.
import type { APIRequestContext } from '@playwright/test'

export async function createTimeTrackingSetup(
  request: APIRequestContext,
  overrides?: { namePrefix?: string; activityCount?: number }
): Promise<{ customerId: number; projectId: number; activityIds: number[] }> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
  const namePrefix = overrides?.namePrefix ?? `Setup ${suffix}`
  const activityCount = overrides?.activityCount ?? 1

  const customerRes = await request.post('/web/index.php/api/v2/time/customers', {
    data: { name: `${namePrefix} Customer` },
  })
  if (customerRes.status() !== 200) {
    throw new Error(
      `createTimeTrackingSetup: customer creation failed with status ${customerRes.status()}`
    )
  }
  const customer = (await customerRes.json()).data

  // Omit `description` on the project POST — sending `""` explicitly is rejected 422.
  const projectRes = await request.post('/web/index.php/api/v2/time/projects', {
    data: { name: `${namePrefix} Project`, customerId: customer.id },
  })
  if (projectRes.status() !== 200) {
    throw new Error(
      `createTimeTrackingSetup: project creation failed with status ${projectRes.status()}`
    )
  }
  const project = (await projectRes.json()).data

  const activityIds: number[] = []
  for (let i = 0; i < activityCount; i++) {
    const activityRes = await request.post(
      `/web/index.php/api/v2/time/project/${project.id}/activities`,
      { data: { name: `${namePrefix} Activity ${i + 1}` } }
    )
    if (activityRes.status() !== 200) {
      throw new Error(
        `createTimeTrackingSetup: activity creation failed with status ${activityRes.status()}`
      )
    }
    activityIds.push((await activityRes.json()).data.id as number)
  }

  return { customerId: customer.id as number, projectId: project.id as number, activityIds }
}
