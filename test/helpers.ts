import { createContext, setGlobalContext, tryGetContext } from '@ghuri/core'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { activateTenant, withoutTenant } from '../src'
import { allModels, Collection, Product, Store, Tag } from './models'

export const backends: TestBackend[] = (process.env.GHURI_TEST_BACKENDS?.split(',') as
  | TestBackend[]
  | undefined) ?? ['sqlite', 'pglite']

/** A global context with `TENANTS.MODEL` set, so `TenantModel`'s foreign key can resolve. */
export function ensureContext(): void {
  if (tryGetContext()) return
  setGlobalContext(
    createContext({
      env: {},
      settings: {
        SECRET_KEY: 'test-secret-key',
        DEBUG: true,
        INSTALLED_APPS: [],
        ROOT_URLCONF: [],
        TENANTS: { MODEL: Store },
      } as any,
    }),
  )
}

export function useDatabase(using: TestBackend): { db: TestDatabase } {
  const h = {} as { db: TestDatabase }
  beforeAll(async () => {
    ensureContext()
    h.db = await setupTestDatabase({ using, models: allModels })
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    activateTenant(null)
    await h.db.flush()
  })
  return h
}

export interface World {
  a: Store
  b: Store
  colA: Collection
  colB: Collection
  tagA: Tag
  tagB: Tag
  pA: Product
  pB: Product
}

/** Two stores with one collection, tag and product each (plus a second product in A). */
export async function seed(): Promise<World> {
  return withoutTenant(async () => {
    const a = await Store.objects.create({
      name: 'A',
      slug: 'amarshop',
      domain: 'shop.a.test',
      token: 'tok-a',
    })
    const b = await Store.objects.create({ name: 'B', slug: 'bshop', domain: 'shop.b.test', token: 'tok-b' })
    const colA = (await Collection.objects.create({ store: a, title: 'Summer A' })) as Collection
    const colB = (await Collection.objects.create({ store: b, title: 'Summer B' })) as Collection
    const tagA = await Tag.objects.create({ store: a, name: 'new' })
    const tagB = await Tag.objects.create({ store: b, name: 'new' })
    const pA = await Product.objects.create({ store: a, title: 'Shirt', handle: 'shirt', collection: colA })
    await Product.objects.create({ store: a, title: 'Cap', handle: 'cap' })
    const pB = await Product.objects.create({ store: b, title: 'Shirt', handle: 'shirt', collection: colB })
    return { a, b, colA, colB, tagA, tagB, pA, pB }
  })
}
