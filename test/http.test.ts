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
  TENANT_NOT_REQUIRED_MARKER,
  TenantMiddleware,
  tenantCache,
  tenantNotRequired,
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

  // The request URL carries the host, as on Workers and Node, where it is built from the Host header.
  const get = (url: string, headers: Record<string, string> = {}) => client.get(url, { headers })
  const at = (host: string, path: string) => get(`http://${host}${path}`)

  it('resolves a subdomain', async () => {
    const res = await at('amarshop.myghuri.test', '/whoami/')
    expect(await res.json()).toEqual({ store: 'amarshop', viaContext: 'amarshop' })
    expect(await (await at('bshop.myghuri.test', '/products/')).json()).toEqual(['Shirt'])
  })

  it('resolves a custom domain and a header token', async () => {
    expect(await (await at('shop.a.test', '/products/')).json()).toEqual(['Cap', 'Shirt'])
    expect(await (await get('/products/', { 'X-Storefront-Token': 'tok-b' })).json()).toEqual(['Shirt'])
  })

  it('answers 404 for an unknown subdomain or token', async () => {
    expect((await at('nope.myghuri.test', '/whoami/')).status).toBe(404)
    expect((await get('/whoami/', { 'X-Storefront-Token': 'nope' })).status).toBe(404)
  })

  it('lets platform hosts through with no tenant, and tenant queries there fail closed', async () => {
    expect(await (await at('www.myghuri.test', '/whoami/')).json()).toEqual({
      store: null,
      viaContext: null,
    })
    expect((await at('admin.platform.test', '/products/')).status).toBe(500)
  })

  it('scopes tenantCache() keys to the tenant', async () => {
    const visit = async (host: string) => (await (await at(host, '/cache/')).json()).visits
    expect(await visit('amarshop.myghuri.test')).toBe(1)
    expect(await visit('amarshop.myghuri.test')).toBe(2)
    expect(await visit('bshop.myghuri.test')).toBe(1)
    await runAsTenant(w.a, async () =>
      expect(tenantCache().makeKey('visits')).toContain(`t:${w.a.pk}:visits`),
    )
  })
})

describe('TENANTS.REQUIRED and tenantNotRequired()', () => {
  let app: GhuriApp
  let db: TestDatabase
  let client: TestClient
  const env: Record<string, unknown> = {}
  // A fresh function per route: tenantNotRequired() marks the function it is given.
  const whoami = () => (c: any) => c.json({ store: currentTenant()?.slug ?? null })

  beforeAll(async () => {
    const settings = defineSettings(() => ({
      SECRET_KEY: 'test-secret',
      DEBUG: false,
      INSTALLED_APPS: [],
      ROOT_URLCONF: [
        path('whoami/', whoami()),
        path('hooks/stripe/', tenantNotRequired(whoami())),
        path(
          'hooks/products/',
          tenantNotRequired(async (c) => c.json(await Product.objects.count())),
        ),
        path('hooks/<int:id>/', tenantNotRequired(whoami())),
      ],
      MIDDLEWARE: [TenantMiddleware],
      TENANTS: {
        MODEL: Store,
        REQUIRED: true,
        RESOLVERS: [new HeaderResolver({ header: 'X-Storefront-Token', field: 'token' })],
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
    await seed()
  })

  it('answers 404 without a tenant, except for views marked tenantNotRequired()', async () => {
    expect((await client.get('/whoami/')).status).toBe(404)
    expect(await (await client.get('/hooks/stripe/')).json()).toEqual({ store: null })
    expect(await (await client.post('/hooks/stripe/', { csrf: false } as any)).json()).toEqual({
      store: null,
    })
    expect(await (await client.get('/hooks/7/')).json()).toEqual({ store: null })
  })

  it('still activates a tenant on marked views, and still answers 404 for an unknown one', async () => {
    const res = await client.get('/hooks/stripe/', { headers: { 'X-Storefront-Token': 'tok-b' } })
    expect(await res.json()).toEqual({ store: 'bshop' })
    expect((await client.get('/hooks/stripe/', { headers: { 'X-Storefront-Token': 'nope' } })).status).toBe(
      404,
    )
  })

  it('keeps tenant-scoped queries fail-closed on a marked view with no tenant', async () => {
    expect((await client.get('/hooks/products/')).status).toBe(500)
  })

  it('marks with a Symbol.for() key, so packages can mark views without importing tenants', () => {
    const view = () => new Response()
    ;(view as any)[Symbol.for('ghuri.tenantNotRequired')] = true
    expect(TENANT_NOT_REQUIRED_MARKER).toBe(Symbol.for('ghuri.tenantNotRequired'))
    expect((tenantNotRequired(() => new Response()) as any)[TENANT_NOT_REQUIRED_MARKER]).toBe(true)
  })
})
