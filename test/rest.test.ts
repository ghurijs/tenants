// @ghuri/rest viewsets and @ghuri/agents tools read through `objects`, so they are scoped to the request's tenant.
import { ModelTools } from '@ghuri/agents'
import { createApp, defineSettings, include, PermissionDenied, path } from '@ghuri/core'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { AllowAny, DefaultRouter, ModelSerializer, ModelViewSet } from '@ghuri/rest'
import { APIClient } from '@ghuri/rest/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CrossTenantError, HeaderResolver, runAsTenant, TenantMiddleware } from '../src'
import { seed, type World } from './helpers'
import { allModels, Product, Store } from './models'

class ProductSerializer extends ModelSerializer<Product> {
  static Meta = { model: Product, fields: ['id', 'title', 'handle', 'collection'] }
}

class ProductViewSet extends ModelViewSet<Product> {
  // Built at import time, with no tenant: scoped per request when it runs.
  queryset = Product.objects.all()
  serializerClass = ProductSerializer
  permissionClasses = [AllowAny]
}

const router = new DefaultRouter()
router.register('products', ProductViewSet)

describe('REST viewsets and agent tools on tenant-scoped models', () => {
  let db: TestDatabase
  let client: APIClient
  let w: World
  const env: Record<string, unknown> = {}

  beforeAll(async () => {
    const settings = defineSettings(() => ({
      SECRET_KEY: 'test-secret',
      DEBUG: false,
      INSTALLED_APPS: [],
      ROOT_URLCONF: [path('api/', include(router.urls))],
      MIDDLEWARE: [TenantMiddleware],
      REST_FRAMEWORK: { DEFAULT_AUTHENTICATION_CLASSES: [], UNAUTHENTICATED_USER: null },
      TENANTS: { MODEL: Store, RESOLVERS: [new HeaderResolver({ header: 'X-Store', field: 'slug' })] },
    }))
    const app = createApp(settings as any, { checks: false })
    await app.setup(env)
    db = await setupTestDatabase({ using: 'sqlite', models: allModels })
    client = new APIClient(app, { env, defaultFormat: 'json' })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
  })
  beforeEach(async () => {
    await db.flush()
    w = await seed()
  })

  const as = (slug: string) => ({ headers: { 'X-Store': slug } })
  const titlesOf = (data: any) => (data.results ?? data).map((p: any) => p.title).sort()

  it('lists and retrieves only the current store', async () => {
    expect(titlesOf((await client.get('/api/products/', undefined, as('amarshop'))).data)).toEqual([
      'Cap',
      'Shirt',
    ])
    expect(titlesOf((await client.get('/api/products/', undefined, as('bshop'))).data)).toEqual(['Shirt'])
    expect((await client.get(`/api/products/${w.pA.pk}/`, undefined, as('amarshop'))).status).toBe(200)
    expect((await client.get(`/api/products/${w.pB.pk}/`, undefined, as('amarshop'))).status).toBe(404)
  })

  it('creates into the current store and refuses foreign keys to another', async () => {
    const ok = await client.post('/api/products/', { title: 'Socks', handle: 'socks' }, as('amarshop'))
    expect(ok.status).toBe(201)
    const created = await Product.unscoped.get({ pk: ok.data.id })
    expect(created.storeId).toBe(w.a.pk)
    const bad = await client.post(
      '/api/products/',
      { title: 'Bad', handle: 'bad', collection: w.colB.pk },
      as('amarshop'),
    )
    expect([bad.status, bad.data]).toEqual([400, expect.anything()])
    expect(await Product.unscoped.filter({ handle: 'bad' }).count()).toBe(0)
  })

  it("cannot update or delete another store's rows", async () => {
    const put = await client.patch(`/api/products/${w.pB.pk}/`, { title: 'hijacked' }, as('amarshop'))
    expect(put.status).toBe(404)
    const del = await client.delete(`/api/products/${w.pB.pk}/`, undefined, as('amarshop'))
    expect(del.status).toBe(404)
    expect((await Product.unscoped.get({ pk: w.pB.pk })).title).toBe('Shirt')
  })

  it('scopes @ghuri/agents ModelTools to the current store', async () => {
    const tools = new ModelTools(Product, { actions: ['list', 'retrieve'] }).getTools()
    const list = tools.find((t) => t.name.endsWith('_list'))!
    const retrieve = tools.find((t) => t.name.endsWith('_retrieve'))!
    const user = { pk: 1, isAuthenticated: true, isAnonymous: false, isActive: true, isStaff: true } as any
    const listed: any = await runAsTenant(w.a, () => list.execute({}, { user }))
    expect(titlesOf(listed)).toEqual(['Cap', 'Shirt'])
    await expect(runAsTenant(w.a, () => retrieve.execute({ id: w.pB.pk }, { user }))).rejects.toThrow()
  })

  it('reports CrossTenantError as HTTP 403', () => {
    expect(new CrossTenantError('x')).toBeInstanceOf(PermissionDenied)
    expect(new CrossTenantError('x').status).toBe(403)
  })
})
