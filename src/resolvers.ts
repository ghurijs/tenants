import { isModelClass, type ModelClass } from '@ghuri/orm'
import type { Context } from 'hono'
import type { TenantLike } from './context'
import { TenantNotFound } from './errors'
import { getTenantModel } from './settings'

/**
 * Finds the tenant of a request. Return the tenant, `null` when the request is not tenant traffic for this
 * resolver (the next one is tried), or throw `TenantNotFound` when it is tenant traffic but no tenant matches.
 */
export interface TenantResolver {
  resolve(c: Context): Promise<TenantLike | null>
}

/** A resolver object or a plain function `(c) => tenant | null`. */
export type TenantResolverEntry = TenantResolver | ((c: Context) => Promise<TenantLike | null>)

export interface LookupOptions {
  /** Tenant model field to match (default per resolver). */
  field?: string
  /** Extra filter, e.g. `{ isActive: true }`: inactive tenants then answer 404. */
  filter?: Record<string, unknown>
  /** Tenant model (default `TENANTS.MODEL`). */
  model?: ModelClass | (() => ModelClass)
}

function tenantModelOf(opts: LookupOptions): ModelClass {
  if (!opts.model) return getTenantModel()
  return isModelClass(opts.model) ? (opts.model as ModelClass) : (opts.model as () => ModelClass)()
}

async function lookup(opts: LookupOptions, field: string, value: string): Promise<TenantLike | null> {
  const model = tenantModelOf(opts)
  try {
    return (await model._baseManager
      .getQueryset()
      .filter({ ...(opts.filter ?? {}), [field]: value })
      .first()) as TenantLike | null
  } catch {
    // A value the column cannot hold (text for an integer key, …) cannot name a tenant.
    return null
  }
}

/** The request host, lower-cased, without port or trailing dot. */
export function requestHost(c: Context): string {
  const raw = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host
  return raw.split(',')[0].trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
}

/**
 * Tenant from a request header, e.g. a storefront token: `new HeaderResolver({ header: 'X-Storefront-Token',
 * field: 'storefrontToken' })`. A header naming no tenant answers 404.
 */
export class HeaderResolver implements TenantResolver {
  readonly header: string
  constructor(readonly options: LookupOptions & { header?: string } = {}) {
    this.header = options.header ?? 'X-Tenant'
  }
  async resolve(c: Context): Promise<TenantLike | null> {
    const value = c.req.header(this.header)?.trim()
    if (!value) return null
    const tenant = await lookup(this.options, this.options.field ?? 'pk', value)
    if (!tenant) throw new TenantNotFound()
    return tenant
  }
}

/**
 * Tenant whose `field` (default `'domain'`) equals the request host: custom domains (`shop.example.com`).
 * Unknown hosts are not tenant traffic (`null`), so platform hosts keep working.
 */
export class HostResolver implements TenantResolver {
  constructor(readonly options: LookupOptions = {}) {}
  async resolve(c: Context): Promise<TenantLike | null> {
    return lookup(this.options, this.options.field ?? 'domain', requestHost(c))
  }
}

/**
 * Tenant from a subdomain of `domain`: `amarshop.myghuri.com` → the tenant whose `field` (default `'slug'`) is
 * `'amarshop'`. Other hosts are not tenant traffic; an unknown subdomain answers 404. `exclude` lists reserved
 * labels (`['www', 'api']`) that are never tenants.
 */
export class SubdomainResolver implements TenantResolver {
  readonly domain: string
  constructor(readonly options: LookupOptions & { domain: string; exclude?: string[] }) {
    this.domain = options.domain.toLowerCase().replace(/^\./, '')
  }
  async resolve(c: Context): Promise<TenantLike | null> {
    const host = requestHost(c)
    const suffix = `.${this.domain}`
    if (!host.endsWith(suffix)) return null
    const label = host.slice(0, -suffix.length)
    if (!label || label.includes('.') || this.options.exclude?.includes(label)) return null
    const tenant = await lookup(this.options, this.options.field ?? 'slug', label)
    if (!tenant) throw new TenantNotFound()
    return tenant
  }
}

/** Run one resolver entry. */
export function runResolver(entry: TenantResolverEntry, c: Context): Promise<TenantLike | null> {
  return typeof entry === 'function' ? entry(c) : entry.resolve(c)
}
