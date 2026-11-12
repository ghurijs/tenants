import { AsyncLocalStorage } from 'node:async_hooks'
import { TenantNotSet } from './errors'

/** Anything with a primary key can be a tenant (usually an instance of `TENANTS.MODEL`). */
export interface TenantLike {
  pk: unknown
}

/** `'tenant'`: queries are scoped · `'bypass'`: inside `withoutTenant()` · `'none'`: queries fail closed. */
export type TenantMode = 'tenant' | 'bypass' | 'none'

/** @internal One frame per `runAsTenant()` / `withoutTenant()` / request. */
export interface TenantFrame {
  tenant: TenantLike | null
  bypass: boolean
  /** Foreign key targets already checked in this frame: `'<app.model>:<field>'` → values. */
  verified: Map<string, Set<string>>
}

const STORAGE_KEY = Symbol.for('ghuri.tenants.storage')
const FALLBACK_KEY = Symbol.for('ghuri.tenants.fallback')
const g = globalThis as any
// One storage per process, even if the module is loaded twice.
if (!g[STORAGE_KEY]) g[STORAGE_KEY] = new AsyncLocalStorage<TenantFrame>()
const storage: AsyncLocalStorage<TenantFrame> = g[STORAGE_KEY]

function newFrame(tenant: TenantLike | null, bypass: boolean): TenantFrame {
  return { tenant, bypass, verified: new Map() }
}

/** @internal The active frame: the innermost `runAsTenant` / `withoutTenant`, else `activateTenant()`'s. */
export function currentFrame(): TenantFrame | undefined {
  return storage.getStore() ?? (g[FALLBACK_KEY] as TenantFrame | undefined)
}

/** How tenant-scoped queries behave right now. */
export function tenantMode(): TenantMode {
  const f = currentFrame()
  if (!f) return 'none'
  if (f.bypass) return 'bypass'
  return f.tenant ? 'tenant' : 'none'
}

/** The active tenant, or `null` (also `null` inside `withoutTenant()`). */
export function currentTenant<T extends TenantLike = any>(): T | null {
  const f = currentFrame()
  return f && !f.bypass ? ((f.tenant as T | null) ?? null) : null
}

/** The active tenant; throws `TenantNotSet` when there is none. */
export function requireTenant<T extends TenantLike = any>(what = 'This operation'): T {
  const t = currentTenant<T>()
  if (!t) {
    throw new TenantNotSet(
      `${what} needs a current tenant: run it inside a request handled by TenantMiddleware, runAsTenant(tenant, fn) or activateTenant(tenant). Use withoutTenant(fn) for platform code that must see every tenant.`,
    )
  }
  return t
}

function checkTenant(tenant: TenantLike): void {
  if (!tenant || tenant.pk === null || tenant.pk === undefined) {
    throw new TypeError('runAsTenant() needs a saved tenant (an object with a primary key).')
  }
}

/** Run `fn` with `tenant` active: every tenant-scoped query inside is filtered to it (queues, cron, CLI, tests). */
export function runAsTenant<R>(tenant: TenantLike, fn: () => R): R {
  checkTenant(tenant)
  return storage.run(newFrame(tenant, false), fn)
}

/**
 * Run `fn` with tenant scoping switched off: tenant-scoped managers see every tenant's rows and writes are not
 * checked. For platform code only (admin of the platform, migrations of data, billing jobs).
 */
export function withoutTenant<R>(fn: () => R): R {
  return storage.run(newFrame(null, true), fn)
}

/**
 * Make `tenant` active outside any `runAsTenant()` (Django-tenants' `connection.set_tenant`): for tests, scripts
 * and REPLs. `runAsTenant()` / `withoutTenant()` / requests still take precedence. Returns a function that
 * restores the previous state; `activateTenant(null)` clears it.
 */
export function activateTenant(tenant: TenantLike | null): () => void {
  if (tenant) checkTenant(tenant)
  const previous = g[FALLBACK_KEY] as TenantFrame | undefined
  g[FALLBACK_KEY] = tenant ? newFrame(tenant, false) : undefined
  return () => {
    g[FALLBACK_KEY] = previous
  }
}

/** Do two primary-key values name the same row (`5` vs `5n` vs `'5'`)? */
export function samePk(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false
  return String(a) === String(b)
}
