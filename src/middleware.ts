import { Middleware } from '@ghuri/core'
import type { Context, Next } from 'hono'
import { runAsTenant, type TenantLike } from './context'
import { TenantNotFound } from './errors'
import { runResolver, type TenantResolverEntry } from './resolvers'
import { tenantSettings } from './settings'

export interface TenantMiddlewareOptions {
  /** Resolvers to try in order (default `TENANTS.RESOLVERS`). */
  resolvers?: TenantResolverEntry[]
  /** Answer 404 when no resolver finds a tenant (default `TENANTS.REQUIRED`, else false). */
  required?: boolean
}

/**
 * Finds the request's tenant with the configured resolvers and runs the rest of the request inside
 * `runAsTenant(tenant, …)`. The tenant is also available as `c.get('tenant')`.
 *
 * ```ts
 * MIDDLEWARE: [SecurityMiddleware, TenantMiddleware, …],
 * TENANTS: {
 *   MODEL: 'stores.Store',
 *   RESOLVERS: [new HeaderResolver({ header: 'X-Storefront-Token', field: 'storefrontToken' })],
 * },
 * ```
 */
export class TenantMiddleware extends Middleware {
  constructor(readonly options: TenantMiddlewareOptions = {}) {
    super()
  }

  async handle(c: Context, next: Next): Promise<Response | void> {
    const settings = tenantSettings()
    const resolvers = (this.options.resolvers ?? settings.RESOLVERS ?? []) as TenantResolverEntry[]
    let tenant: TenantLike | null = null
    for (const r of resolvers) {
      tenant = await runResolver(r, c)
      if (tenant) break
    }
    if (!tenant) {
      if (this.options.required ?? settings.REQUIRED ?? false) throw new TenantNotFound()
      return next()
    }
    c.set('tenant' as never, tenant as never)
    return runAsTenant(tenant, () => next())
  }
}
