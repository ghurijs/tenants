import { GhuriError, Http404 } from '@ghuri/core'

/** A tenant-scoped model was queried or saved while no tenant is active (and not inside `withoutTenant()`). */
export class TenantNotSet extends GhuriError {}

/** A write would read or change another tenant's rows, or point a foreign key at another tenant's row. */
export class CrossTenantError extends GhuriError {}

/** A resolver recognised the request as tenant traffic but no matching tenant exists (HTTP 404). */
export class TenantNotFound extends Http404 {
  constructor(message = 'Tenant not found.') {
    super(message)
  }
}
