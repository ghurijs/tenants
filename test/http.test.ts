import { createApp, defineSettings, type GhuriApp, memoryCache, path } from '@ghuri/core'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  currentTenant,
  HeaderResolver,
  HostResolver,
  runAsTenant,
  SubdomainResolver,
  TenantMiddleware,
  tenantCache,
  uuid7,
  uuid7Time,
} from '../src'
import { seed, type World } from './helpers'
import { allModels, Product, Store } from './models'

const urls = [
  path('products/', async (c) => c.json((await Product.objects.all()).map((p) => p.title).sort())),
  path('whoami/', (c) =>
    c.json({ store: currentTenant()?.slug ?? null, viaContext: (c.get as any)('tenant')?.slug ?? null }),
  ),
  path('cache/', async (c) => {
    const cache = tenantCache()
    const before = await cache.get('visits', 0)
    await cache.set('visits', (before as number) + 1)
    return c.json({ visits: await cache.get('visits') })
  }),
]

describe('TenantMiddleware and resolvers', () => {
  let app: GhuriApp
  let db: TestDatabase
  let client: TestClient
  let w: World
  const env: Record<string, unknown> = {}

  beforeAll(async () => {
    const settings = defineSettings(() => ({
      SECRET_KEY: 'test-secret',
      DEBUG: false,
      INSTALLED_APPS: [],
      ROOT_URLCONF: urls,
      MIDDLEWARE: [TenantMiddleware],
      CACHES: { default: memoryCache() },
      TENANTS: {
        MODEL: Store,
        RESOLVERS: [
          new HeaderResolver({ header: 'X-Storefront-Token', field: 'token' }),
          new SubdomainResolver({ domain: 'myghuri.test', exclude: ['www', 'api'] }),
          new HostResolver({ field: 'domain' }),
        ],
      },
    }))
    app = createApp(settings as any, { checks: false })
    await app.setup(env)
    db = await setupTestDatabase({ using: 'sqlite', models: allModels })
    client = createTestClient(app, { env })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
  })
  beforeEach(async () => {
    await db.flush()
    w = await seed()
  })

  const get = (url: string, headers: Record<string, string> = {}) => client.get(url, { headers })

  it('resolves a subdomain', async () => {
    const res = await get('/whoami/', { host: 'amarshop.myghuri.test' })
    expect(await res.json()).toEqual({ store: 'amarshop', viaContext: 'amarshop' })
    expect(await (await get('/products/', { host: 'bshop.myghuri.test' })).json()).toEqual(['Shirt'])
  })

  it('resolves a custom domain and a header token', async () => {
    expect(await (await get('/products/', { host: 'shop.a.test' })).json()).toEqual(['Cap', 'Shirt'])
    expect(await (await get('/products/', { 'X-Storefront-Token': 'tok-b' })).json()).toEqual(['Shirt'])
  })

  it('answers 404 for an unknown subdomain or token', async () => {
    expect((await get('/whoami/', { host: 'nope.myghuri.test' })).status).toBe(404)
    expect((await get('/whoami/', { 'X-Storefront-Token': 'nope' })).status).toBe(404)
  })

  it('lets platform hosts through with no tenant, and tenant queries there fail closed', async () => {
    expect(await (await get('/whoami/', { host: 'www.myghuri.test' })).json()).toEqual({
      store: null,
      viaContext: null,
    })
    expect((await get('/products/', { host: 'admin.platform.test' })).status).toBe(500)
  })

  it('scopes tenantCache() keys to the tenant', async () => {
    const visit = async (host: string) => (await (await get('/cache/', { host })).json()).visits
    expect(await visit('amarshop.myghuri.test')).toBe(1)
    expect(await visit('amarshop.myghuri.test')).toBe(2)
    expect(await visit('bshop.myghuri.test')).toBe(1)
    await runAsTenant(w.a, async () =>
      expect(tenantCache().makeKey('visits')).toContain(`t:${w.a.pk}:visits`),
    )
  })
})

describe('uuid7', () => {
  it('is a version 7 UUID that sorts by time', () => {
    const before = Date.now()
    const ids = Array.from({ length: 50 }, () => uuid7())
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(uuid7Time(id)).toBeGreaterThanOrEqual(before)
      expect(uuid7Time(id)).toBeLessThanOrEqual(Date.now())
    }
    expect(new Set(ids).size).toBe(50)
  })
})
