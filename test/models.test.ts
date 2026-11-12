import { Count } from '@ghuri/orm'
import { describe, expect, it } from 'vitest'
import {
  activateTenant,
  CrossTenantError,
  currentTenant,
  isTenantModel,
  runAsTenant,
  TenantNotSet,
  tenantFieldOf,
  tenantMode,
  withoutTenant,
} from '../src'
import { assertTenantIsolation, TenantLeakError } from '../src/testing'
import { backends, seed, useDatabase } from './helpers'
import { Collection, Memo, Note, Product, Store, Tag } from './models'

const titles = (rows: Array<{ title: string }>) => rows.map((r) => r.title).sort()

describe.each(backends)('tenant-scoped models (%s)', (using) => {
  useDatabase(using)

  describe('context', () => {
    it('reports the mode and nests', async () => {
      const { a, b } = await seed()
      expect(tenantMode()).toBe('none')
      await runAsTenant(a, async () => {
        expect(tenantMode()).toBe('tenant')
        expect(currentTenant()).toBe(a)
        await runAsTenant(b, async () => expect(currentTenant()).toBe(b))
        await withoutTenant(async () => {
          expect(tenantMode()).toBe('bypass')
          expect(currentTenant()).toBeNull()
        })
        expect(currentTenant()).toBe(a)
      })
      const restore = activateTenant(b)
      expect(currentTenant()).toBe(b)
      restore()
      expect(tenantMode()).toBe('none')
    })

    it('marks tenant-scoped models', () => {
      expect(isTenantModel(Product)).toBe(true)
      expect(isTenantModel(Store)).toBe(false)
      expect(tenantFieldOf(Product)).toBe('store')
      expect(tenantFieldOf(Memo)).toBe('tenant')
    })
  })

  describe('reads', () => {
    it('scopes objects, filters, get, count, values and aggregates to the current tenant', async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        expect(titles(await Product.objects.all())).toEqual(['Cap', 'Shirt'])
        expect(await Product.objects.count()).toBe(2)
        expect(await Product.objects.filter({ handle: 'shirt' }).count()).toBe(1)
        expect((await Product.objects.get({ handle: 'shirt' })).pk).toBe(w.pA.pk)
        await expect(Product.objects.get({ pk: w.pB.pk })).rejects.toThrow(Product.DoesNotExist)
        expect(await Product.objects.filter({ pk: w.pB.pk }).exists()).toBe(false)
        expect((await Product.objects.valuesList('title', { flat: true }).fetch()).sort()).toEqual([
          'Cap',
          'Shirt',
        ])
        expect(await Product.objects.aggregate({ n: Count('id') })).toEqual({ n: 2 })
        expect(titles(await Product.objects.filter({ collection__title__startswith: 'Summer' }))).toEqual([
          'Shirt',
        ])
      })
      await runAsTenant(w.b, async () => {
        expect(titles(await Product.objects.all())).toEqual(['Shirt'])
      })
    })

    it('scopes reverse relations and many-to-many managers', async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        const col = (await Collection.objects.get({ pk: w.colA.pk })) as Collection
        expect(titles(await col.products.all())).toEqual(['Shirt'])
        const p = await Product.objects.get({ pk: w.pA.pk })
        await p.tags.add(w.tagA)
        expect((await p.tags.all()).map((t) => t.pk)).toEqual([w.tagA.pk])
      })
    })

    it('applies the filter when the QuerySet runs, not when it is built', async () => {
      const w = await seed()
      // Built at "import time" with no tenant, like `static queryset = Product.objects.all()` on a viewset.
      const qs = Product.objects.filter({ handle: 'shirt' })
      expect((await runAsTenant(w.a, () => qs.all().fetch())).map((p) => p.pk)).toEqual([w.pA.pk])
      expect((await runAsTenant(w.b, () => qs.all().fetch())).map((p) => p.pk)).toEqual([w.pB.pk])
    })

    it('scopes tenant QuerySets used as subqueries', async () => {
      const w = await seed()
      const sub = () => Product.objects.valuesList('collection', { flat: true })
      const viaA = await runAsTenant(w.a, () => Collection.unscoped.filter({ pk__in: sub() }).fetch())
      expect(viaA.map((c) => c.pk)).toEqual([w.colA.pk])
      // No tenant: the subquery matches nothing instead of every tenant's rows.
      expect(await Collection.unscoped.filter({ pk__in: sub() }).count()).toBe(0)
    })

    it('fails closed with no tenant', async () => {
      await seed()
      await expect(Product.objects.all().fetch()).rejects.toThrow(TenantNotSet)
      await expect(Product.objects.count()).rejects.toThrow(TenantNotSet)
      await expect(Product.objects.filter({ handle: 'x' }).exists()).rejects.toThrow(TenantNotSet)
      await expect(Product.objects.update({ title: 'x' })).rejects.toThrow(TenantNotSet)
      await expect(Product.objects.all().delete()).rejects.toThrow(TenantNotSet)
      await expect(Product.objects.create({ title: 'x', handle: 'x' })).rejects.toThrow(TenantNotSet)
    })

    it('sees every tenant inside withoutTenant() and through unscoped', async () => {
      await seed()
      expect(await withoutTenant(() => Product.objects.count())).toBe(3)
      expect(await Product.unscoped.count()).toBe(3)
    })

    it('resolves TenantModel to TENANTS.MODEL', async () => {
      const { a } = await seed()
      const memo = await runAsTenant(a, () => Memo.objects.create({ text: 'hello' }))
      expect(memo.tenantId).toBe(a.pk)
      expect(Memo._meta.getForwardField('tenant')?.relatedModel).toBe(Store)
    })
  })

  describe('writes', () => {
    it('fills the tenant on create and save, with UUIDv7 keys', async () => {
      const { a } = await seed()
      await runAsTenant(a, async () => {
        const p = await Product.objects.create({ title: 'Socks', handle: 'socks' })
        expect(p.storeId).toBe(a.pk)
        expect(p.pk).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        const t = new Tag({ name: 'sale' })
        await t.save()
        expect(t.storeId).toBe(a.pk)
      })
    })

    it("refuses to save another tenant's object", async () => {
      const w = await seed()
      const pB = await Product.unscoped.get({ pk: w.pB.pk })
      await runAsTenant(w.a, async () => {
        pB.title = 'hijacked'
        await expect(pB.save()).rejects.toThrow(CrossTenantError)
        await expect(Product.objects.create({ store: w.b, title: 'x', handle: 'x' })).rejects.toThrow(
          CrossTenantError,
        )
      })
      expect((await Product.unscoped.get({ pk: w.pB.pk })).title).toBe('Shirt')
    })

    it("refuses foreign keys to another tenant's rows", async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        await expect(Product.objects.create({ title: 'x', handle: 'x', collection: w.colB })).rejects.toThrow(
          CrossTenantError,
        )
        const p = await Product.objects.get({ pk: w.pA.pk })
        p.collectionId = w.colB.pk
        await expect(p.save()).rejects.toThrow(CrossTenantError)
        p.collectionId = w.colA.pk
        await p.save()
      })
    })

    it("refuses an explicit key that names another tenant's row", async () => {
      const { a, b } = await seed()
      const theirs = await runAsTenant(b, () => Note.objects.create({ body: 'secret' }))
      await runAsTenant(a, async () => {
        const forged = new Note({ id: theirs.pk, body: 'overwritten' })
        await expect(forged.save()).rejects.toThrow(CrossTenantError)
      })
      expect((await Note.unscoped.get({ pk: theirs.pk })).body).toBe('secret')
    })

    it('keeps update() inside the tenant', async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        expect(await Product.objects.update({ title: 'Renamed' })).toBe(2)
        await expect(Product.objects.update({ store: w.b })).rejects.toThrow(CrossTenantError)
        await expect(Product.objects.update({ collection: w.colB })).rejects.toThrow(CrossTenantError)
      })
      expect((await Product.unscoped.get({ pk: w.pB.pk })).title).toBe('Shirt')
    })

    it('checks bulkCreate() and bulkUpdate()', async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        const made = await Product.objects.bulkCreate([
          new Product({ title: 'One', handle: 'one' }),
          new Product({ title: 'Two', handle: 'two', collection: w.colA }),
        ])
        expect(made.every((p) => p.storeId === w.a.pk)).toBe(true)
        await expect(
          Product.objects.bulkCreate([new Product({ title: 'Bad', handle: 'bad', collection: w.colB })]),
        ).rejects.toThrow(CrossTenantError)

        const mine = await Product.objects.all().fetch()
        for (const p of mine) p.title = 'Bulk'
        expect(await Product.objects.bulkUpdate(mine, ['title'])).toBe(mine.length)
        await expect(Product.objects.bulkUpdate(mine, ['store'])).rejects.toThrow(CrossTenantError)
      })
      const pB = await Product.unscoped.get({ pk: w.pB.pk })
      await runAsTenant(w.a, async () => {
        pB.title = 'hijacked'
        await expect(Product.objects.bulkUpdate([pB], ['title'])).rejects.toThrow(CrossTenantError)
        const forged = new Product({ id: w.pB.pk, store: w.a, title: 'hijacked', handle: 'shirt' })
        await expect(Product.objects.bulkUpdate([forged], ['title'])).rejects.toThrow(CrossTenantError)
      })
      expect((await Product.unscoped.get({ pk: w.pB.pk })).title).toBe('Shirt')
    })

    it("deletes only the current tenant's rows", async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        const [n] = await Product.objects.all().delete()
        expect(n).toBeGreaterThanOrEqual(2)
      })
      expect(await Product.unscoped.count()).toBe(1)
    })

    it("refuses many-to-many links to another tenant's rows", async () => {
      const w = await seed()
      await runAsTenant(w.a, async () => {
        const p = await Product.objects.get({ pk: w.pA.pk })
        await expect(p.tags.add(w.tagB)).rejects.toThrow(CrossTenantError)
        await expect(p.tags.add(w.tagB.pk)).rejects.toThrow(CrossTenantError)
        await p.tags.add(w.tagA)
      })
    })

    it('skips every check inside withoutTenant()', async () => {
      const w = await seed()
      await withoutTenant(async () => {
        const p = await Product.objects.get({ pk: w.pB.pk })
        p.title = 'Platform edit'
        await p.save()
      })
      expect((await Product.unscoped.get({ pk: w.pB.pk })).title).toBe('Platform edit')
    })
  })

  describe('assertTenantIsolation', () => {
    it('passes for scoped code and reports leaks', async () => {
      const w = await seed()
      await assertTenantIsolation({
        tenants: [w.a, w.b],
        models: [Product, Collection, Tag],
        run: async () => ({ products: await Product.objects.all(), first: await Collection.objects.first() }),
      })
      const leak = assertTenantIsolation({
        tenants: [w.a, w.b],
        models: [Product],
        run: () => Product.unscoped.all().fetch(),
      })
      await expect(leak).rejects.toThrow(TenantLeakError)
      await expect(leak).rejects.toThrow(/returned Product .* of tenant/)
    })
  })
})
