// A store's shoppers: a tenant-scoped model that extends AbstractBaseUser, with its own JWT type. A customer
// token only works on the store that issued it, and is never accepted as an AUTH_USER_MODEL token.
import { AbstractBaseUser, AccessToken, PBKDF2PasswordHasher, RefreshToken, UserManager } from '@ghuri/auth'
import { JWTAuthentication } from '@ghuri/auth/rest'
import { createApp, csrfExempt, defineSettings, json, path } from '@ghuri/core'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { BooleanField, EmailField } from '@ghuri/orm'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import type { Context } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HeaderResolver, runAsTenant, TenantMiddleware, tenantModel } from '../src'
import { seed, type World } from './helpers'
import { allModels, Store } from './models'

const CustomerModel = tenantModel({
  field: 'store',
  to: () => Store,
  uuidPk: true,
  extends: AbstractBaseUser,
})

class Customer extends CustomerModel({
  email: new EmailField(),
  isActive: new BooleanField({ default: true }),
}) {
  static Meta = { appLabel: 'shop', uniqueTogether: [['store', 'email']] }
  static override USERNAME_FIELD = 'email'
}

class CustomerAccessToken extends AccessToken {
  static override tokenType = 'customer_access'
  static override userModel() {
    return Customer as any
  }
}
class CustomerRefreshToken extends RefreshToken {
  static override tokenType = 'customer_refresh'
  static override accessTokenClass = CustomerAccessToken
  static override userModel() {
    return Customer as any
  }
}
class CustomerJWTAuthentication extends JWTAuthentication {
  override tokenClasses = [CustomerAccessToken]
}

const urls = [
  path(
    'login/',
    csrfExempt(async (c: Context) => {
      const { email, password } = await c.req.json()
      const customer = (await Customer.objects.filter({ email }).first()) as Customer | null
      if (!customer || !(await customer.checkPassword(password))) return json(c, { error: 'invalid' }, 400)
      const refresh = await CustomerRefreshToken.forUser(customer as any)
      return json(c, { access: await refresh.accessToken.encode(), refresh: await refresh.encode() })
    }),
  ),
  path('me/', async (c: Context) => {
    try {
      const result = await new CustomerJWTAuthentication().authenticate(c)
      if (!result) return json(c, { who: null }, 401)
      return json(c, { who: (result[0] as any).email })
    } catch (err: any) {
      return json(c, { error: err.message }, 401)
    }
  }),
  path('admin-me/', async (c: Context) => {
    try {
      const result = await new JWTAuthentication().authenticate(c)
      return json(c, { who: result ? 'user' : null }, result ? 200 : 401)
    } catch (err: any) {
      return json(c, { error: err.message }, 401)
    }
  }),
]

describe('per-store customers with their own JWTs', () => {
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
      PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })],
      TENANTS: { MODEL: Store, RESOLVERS: [new HeaderResolver({ header: 'X-Store', field: 'slug' })] },
    }))
    const app = createApp(settings as any, { checks: false })
    await app.setup(env)
    db = await setupTestDatabase({ using: 'sqlite', models: [...allModels, Customer] })
    client = createTestClient(app, { env })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
  })
  beforeEach(async () => {
    await db.flush()
    w = await seed()
    for (const [store, password] of [
      [w.a, 'pw-a'],
      [w.b, 'pw-b'],
    ] as const) {
      await runAsTenant(store, async () => {
        // The same email in two stores: two different customers.
        const c = new Customer({ email: 'sam@example.com' })
        await c.setPassword(password)
        await c.save()
      })
    }
  })

  const login = async (store: string, password: string) =>
    client.post('/login/', { json: { email: 'sam@example.com', password }, headers: { 'X-Store': store } })
  const me = (store: string, access: string, url = '/me/') =>
    client.get(url, { headers: { 'X-Store': store, authorization: `Bearer ${access}` } })

  it("keeps the base model's manager class, scoped to the store", async () => {
    expect(Customer.objects).toBeInstanceOf(UserManager)
    expect(Customer.objects.constructor.name).toBe('TenantUserManager')
    expect(await runAsTenant(w.a, () => Customer.objects.count())).toBe(1)
    expect(await Customer.unscoped.count()).toBe(2)
  })

  it("logs in against the request's store only", async () => {
    expect((await login('amarshop', 'pw-a')).status).toBe(200)
    expect((await login('amarshop', 'pw-b')).status).toBe(400)
    expect((await login('bshop', 'pw-b')).status).toBe(200)
  })

  it('accepts a customer token only on the store that issued it', async () => {
    const { access } = await (await login('amarshop', 'pw-a')).json()
    expect(await (await me('amarshop', access)).json()).toEqual({ who: 'sam@example.com' })
    expect((await me('bshop', access)).status).toBe(401)
  })

  it('never accepts a customer token as an AUTH_USER_MODEL token', async () => {
    const { access } = await (await login('amarshop', 'pw-a')).json()
    expect((await me('amarshop', access, '/admin-me/')).status).toBe(401)
  })
})
