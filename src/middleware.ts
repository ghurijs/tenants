import { getResolver, Middleware, settingsFor } from '@ghuri/core'
import type { Context, Next } from 'hono'
import { matchedRoutes } from 'hono/route'
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
 * Marker set on views by `tenantNotRequired()`. It is a `Symbol.for()` key, so a package can mark its views without
 * importing `@ghuri/tenants` (`@ghuri/billing` marks its webhook view this way).
 */
export const TENANT_NOT_REQUIRED_MARKER: symbol = Symbol.for('ghuri.tenantNotRequired')

/**
 * Let a view (or a mounted Hono app) run without a tenant when `TENANTS.REQUIRED` is on, like Django's
 * `login_not_required` for `LoginRequiredMiddleware`: for requests that carry no tenant, such as a payment
 * provider's webhook or a health check. A tenant the resolvers do find is still activated, and an unknown tenant
 * still answers 404. Without a tenant, tenant-scoped queries in the view fail closed (`TenantNotSet`).
 *
 * ```ts
 * path('stripe/webhook/', tenantNotRequired(webhook))
 * ```
 */
export function tenantNotRequired<T extends object>(view: T): T {
  ;(view as any)[TENANT_NOT_REQUIRED_MARKER] = true
  return view
}

/** Does the request's view (or mounted Hono app) carry the `tenantNotRequired()` marker? */
export function isTenantNotRequired(c: Context): boolean {
  try {
    for (const r of matchedRoutes(c)) if ((r.handler as any)?.[TENANT_NOT_REQUIRED_MARKER]) return true
  } catch {
    // no route information
  }
  const settings = settingsFor(c)
  if (!settings?.ROOT_URLCONF) return false
  try {
    const m = getResolver(settings.ROOT_URLCONF as any).match(c.req.path, c.req.method)
    return !!((m?.view as any)?.[TENANT_NOT_REQUIRED_MARKER] || (m?.app as any)?.[TENANT_NOT_REQUIRED_MARKER])
  } catch {
    return false
  }
}

/**
 * Finds the request's tenant with the configured resolvers and runs the rest of the request inside
 * `runAsTenant(tenant, …)`. The tenant is also available as `c.get('tenant')`. With `required`, a request with no
 * tenant answers 404 unless its view is marked with `tenantNotRequired()`.
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
      if ((this.options.required ?? settings.REQUIRED ?? false) && !isTenantNotRequired(c))
        throw new TenantNotFound()
      return next()
    }
    c.set('tenant' as never, tenant as never)
    return runAsTenant(tenant, () => next())
  }
}
