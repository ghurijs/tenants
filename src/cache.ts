import { type Cache, caches, GhuriError } from '@ghuri/core'
import { requireTenant } from './context'

/** The `Cache` methods `tenantCache()` scopes to the current tenant. */
export type TenantCache = Pick<
  Cache,
  | 'get'
  | 'set'
  | 'add'
  | 'delete'
  | 'has'
  | 'getOrSet'
  | 'getMany'
  | 'setMany'
  | 'deleteMany'
  | 'incr'
  | 'decr'
> & {
  /** Delete this tenant's keys (backends that can clear by prefix: memory, KV; throws elsewhere). */
  clear(): Promise<void>
  /** The key as stored in the underlying cache. */
  makeKey(key: string): string
}

/**
 * A cache (alias `'default'` unless given) whose keys are prefixed with the current tenant (`t:<pk>:<key>`), so
 * cached data never crosses tenants. Resolve it inside the tenant's request or `runAsTenant()`.
 */
export function tenantCache(alias = 'default'): TenantCache {
  const base = caches.get(alias)
  const prefix = `t:${String(requireTenant('tenantCache()').pk)}:`
  const k = (key: string) => `${prefix}${key}`
  const unprefix = <T>(m: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(m).map(([key, v]) => [key.slice(prefix.length), v]))
  return {
    get: ((key: string, fallback?: unknown) => base.get(k(key), fallback as any)) as Cache['get'],
    set: (key, value, ttl) => base.set(k(key), value, ttl),
    add: (key, value, ttl) => base.add(k(key), value, ttl),
    delete: (key) => base.delete(k(key)),
    has: (key) => base.has(k(key)),
    getOrSet: (key, valueOrFn, ttl) => base.getOrSet(k(key), valueOrFn, ttl),
    getMany: (async (keys: string[]) => unprefix(await base.getMany(keys.map(k)))) as Cache['getMany'],
    setMany: (values, ttl) =>
      base.setMany(Object.fromEntries(Object.entries(values).map(([key, v]) => [k(key), v])), ttl),
    deleteMany: (keys) => base.deleteMany(keys.map(k)),
    incr: (key, delta) => base.incr(k(key), delta),
    decr: (key, delta) => base.decr(k(key), delta),
    clear: async () => {
      if (!base.backend.clear) throw new GhuriError('This cache backend does not support clear().')
      await base.backend.clear(base.makeKey(prefix))
    },
    makeKey: (key) => base.makeKey(k(key)),
  }
}
