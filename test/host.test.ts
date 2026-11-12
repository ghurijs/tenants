import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CsrfMiddleware, createApp, defineSettings, type GhuriApp, getHost, path } from '@ghuri/core'
import { serve } from '@ghuri/core/node'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { currentTenant, HostResolver, requestHost, SubdomainResolver, TenantMiddleware } from '../src'
import { seed } from './helpers'
import { allModels, Store } from './models'

const urls = [
  path('host/', (c) =>
    c.json({ tenantHost: requestHost(c), csrfHost: getHost(c), store: currentTenant()?.slug ?? null }),
  ),
]

function makeApp(useForwardedHost: boolean): GhuriApp {
  const settings = defineSettings(() => ({
    SECRET_KEY: 'test-secret',
    DEBUG: false,
    INSTALLED_APPS: [],
    ROOT_URLCONF: urls,
    MIDDLEWARE: [CsrfMiddleware, TenantMiddleware],
    ...(useForwardedHost ? { USE_X_FORWARDED_HOST: true } : {}),
    TENANTS: {
      MODEL: Store,
      RESOLVERS: [
        new SubdomainResolver({ domain: 'myghuri.test', exclude: ['www'] }),
        new HostResolver({ field: 'domain' }),
      ],
    },
  }))
  return createApp(settings as any, { checks: false })
}

/** A plain HTTP request with an explicit Host header, as a browser or proxy sends it. */
function rawGet(
  port: number,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        let body: any = data
        try {
          body = JSON.parse(data)
        } catch {
          // not JSON: keep the text, so a failing assertion shows it
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('requestHost() and the CSRF host', () => {
  let db: TestDatabase
  let plain: TestClient
  let proxied: TestClient
  let plainApp: GhuriApp
  const env: Record<string, unknown> = {}

  beforeAll(async () => {
    plainApp = makeApp(false)
    const proxiedApp = makeApp(true)
    const plainCtx = await plainApp.setup(env)
    const proxiedCtx = await proxiedApp.setup(env)
    // The test database is merged into the current (last set up) context; share it with the other app.
    db = await setupTestDatabase({ using: 'sqlite', models: allModels })
    plainCtx.settings.DATABASES = proxiedCtx.settings.DATABASES
    plain = createTestClient(plainApp, { env })
    proxied = createTestClient(proxiedApp, { env })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
  })
  beforeEach(async () => {
    await db.flush()
    await seed()
  })

  it('ignores X-Forwarded-Host unless USE_X_FORWARDED_HOST is set', async () => {
    const res = await plain.get('http://shop.a.test/host/', {
      headers: { 'X-Forwarded-Host': 'shop.b.test' },
    })
    expect(await res.json()).toEqual({
      tenantHost: 'shop.a.test',
      csrfHost: 'shop.a.test',
      store: 'amarshop',
    })
    // A client cannot pick a tenant by sending the header to a platform host.
    const platform = await plain.get('/host/', { headers: { 'X-Forwarded-Host': 'bshop.myghuri.test' } })
    expect(await platform.json()).toEqual({ tenantHost: 'testserver', csrfHost: 'testserver', store: null })
  })

  it('honours X-Forwarded-Host with USE_X_FORWARDED_HOST, and agrees with getHost()', async () => {
    const res = await proxied.get('/host/', {
      headers: { 'X-Forwarded-Host': 'BShop.MyGhuri.test.:8443, proxy.internal' },
    })
    expect(await res.json()).toEqual({
      tenantHost: 'bshop.myghuri.test',
      csrfHost: 'BShop.MyGhuri.test.:8443',
      store: 'bshop',
    })
    // The CSRF Origin check sees the same host the tenant was resolved from.
    const ok = await proxied.post('/host/', {
      headers: { 'X-Forwarded-Host': 'shop.b.test', Origin: 'http://shop.b.test' },
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({
      tenantHost: 'shop.b.test',
      csrfHost: 'shop.b.test',
      store: 'bshop',
    })
    // Without the setting, both ignore the header: the Origin no longer matches and the tenant is not B.
    const rejected = await plain.post('/host/', {
      headers: { 'X-Forwarded-Host': 'shop.b.test', Origin: 'http://shop.b.test' },
    })
    expect(rejected.status).toBe(403)
  })

  it('uses the Host header on a real server', async () => {
    const server = await serve(plainApp, {
      port: 0,
      hostname: '127.0.0.1',
      env,
      handleSignals: false,
      onListen() {},
    })
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', resolve)))
    try {
      const { port } = server.address() as AddressInfo
      const res = await rawGet(port, '/host/', { host: 'AmarShop.MyGhuri.test:8443' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        tenantHost: 'amarshop.myghuri.test',
        csrfHost: 'amarshop.myghuri.test:8443',
        store: 'amarshop',
      })
      // X-Forwarded-Host is still ignored there without the setting.
      const custom = await rawGet(port, '/host/', { host: 'shop.a.test', 'x-forwarded-host': 'shop.b.test' })
      expect(custom.body).toMatchObject({ tenantHost: 'shop.a.test', store: 'amarshop' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
