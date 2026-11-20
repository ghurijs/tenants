import { captureContext, getContextCarriers, restoreContext } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { currentTenant, runAsTenant, TenantNotFound, TenantNotSet, withoutTenant } from '../src'
import { backends, seed, useDatabase } from './helpers'
import { Product } from './models'

describe.each(backends)('tenant context carrier (%s)', (using) => {
  useDatabase(using)

  it('is registered', () => {
    expect(getContextCarriers()).toContain('tenant')
  })

  it('captures the tenant pk and restores the tenant', async () => {
    const { a, b } = await seed()
    expect(captureContext()).toEqual({})
    const captured = await runAsTenant(a, async () => captureContext())
    expect(captured).toEqual({ tenant: String(a.pk) })
    const titles = await restoreContext(captured, async () => {
      expect(String(currentTenant()?.pk)).toBe(String(a.pk))
      return (await Product.objects.orderBy('title')).map((p: any) => p.title)
    })
    expect(titles).toEqual(['Cap', 'Shirt'])
    const other = await runAsTenant(b, async () => captureContext())
    expect(await restoreContext(other, () => Product.objects.count())).toBe(1)
  })

  it('does not carry withoutTenant()', async () => {
    await seed()
    const captured = await withoutTenant(async () => captureContext())
    expect(captured).toEqual({})
    await expect(restoreContext(captured, () => Product.objects.count())).rejects.toThrow(TenantNotSet)
  })

  it('fails for a tenant that no longer exists', async () => {
    await seed()
    await expect(restoreContext({ tenant: '999999' }, async () => 1)).rejects.toThrow(TenantNotFound)
  })
})
