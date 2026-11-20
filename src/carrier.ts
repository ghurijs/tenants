import * as core from '@ghuri/core'
import { currentTenant, runAsTenant, withoutTenant } from './context'
import { TenantNotFound } from './errors'
import { getTenantModel } from './settings'

/** Name of the tenant's entry in `captureContext()` (`{ tenant: '<pk>' }`). */
export const TENANT_CARRIER = 'tenant'

/**
 * Lets work that leaves the request (queued agent runs, background jobs, calls to other services) take the current
 * tenant along: `captureContext()` records its primary key and `restoreContext()` runs the work as that tenant
 * again. `withoutTenant()` is not carried: restored work runs with no tenant, so tenant-scoped queries fail closed.
 */
export const tenantCarrier: core.ContextCarrier = {
  name: TENANT_CARRIER,
  capture() {
    const pk = currentTenant()?.pk
    return pk === null || pk === undefined ? undefined : String(pk)
  },
  async restore(value, fn) {
    const Tenant = getTenantModel()
    const tenant = await withoutTenant(() => (Tenant as any).objects.filter({ pk: value }).first())
    if (!tenant) throw new TenantNotFound(`Tenant '${value}' not found.`)
    return runAsTenant(tenant, fn)
  },
}

// Older @ghuri/core releases have no carrier registry: tenants still works there, only without carrying.
;(core as any).registerContextCarrier?.(tenantCarrier)
