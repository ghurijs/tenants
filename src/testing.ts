// @ghuri/tenants/testing — check that tenant-scoped code never returns another tenant's rows.
import { GhuriError } from '@ghuri/core'
import { BaseModel, isAbstractModel, type ModelClass, modelRegistry } from '@ghuri/orm'
import { runAsTenant, samePk, type TenantLike, withoutTenant } from './context'
import { tenantFieldOf } from './models'

/** `assertTenantIsolation()` found rows of one tenant while another was active. */
export class TenantLeakError extends GhuriError {
  constructor(readonly leaks: string[]) {
    super(`Tenant isolation failed:\n- ${leaks.join('\n- ')}`)
  }
}

export interface TenantIsolationOptions {
  /** Two or more saved tenants, each with some rows. */
  tenants: TenantLike[]
  /** Tenant-scoped models whose `objects` to check (default: every registered tenant-scoped model). */
  models?: ModelClass[]
  /**
   * Your own code to check, run once as each tenant (a view's queryset, a resolver, a service function). Every
   * tenant-scoped model instance in what it returns (arrays, objects, Maps and Sets are searched) must belong to
   * the tenant it ran as.
   */
  run?: (tenant: TenantLike) => unknown | Promise<unknown>
}

function tenantModels(): ModelClass[] {
  return [...modelRegistry.all].filter((m) => isTenantModel(m) && !isAbstractModel(m))
}

function isTenantModel(m: unknown): boolean {
  return tenantFieldOf(m) !== undefined
}

function ownerOf(obj: BaseModel): unknown {
  const model = obj.constructor as ModelClass
  const field = tenantFieldOf(model) as string
  const attname = model._meta.getForwardField(field)?.attname ?? `${field}Id`
  return (obj as any)[attname]
}

function collectInstances(value: unknown, out: BaseModel[], seen = new Set<unknown>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (value instanceof BaseModel) {
    if (isTenantModel(value.constructor)) out.push(value)
    return
  }
  if (Array.isArray(value) || value instanceof Set) {
    for (const v of value) collectInstances(v, out, seen)
    return
  }
  if (value instanceof Map) {
    for (const v of value.values()) collectInstances(v, out, seen)
    return
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    for (const v of Object.values(value)) collectInstances(v, out, seen)
  }
}

/**
 * Run every tenant-scoped model's `objects.all()` (and `run`, when given) as each tenant and fail with
 * `TenantLeakError` if a row of another tenant comes back, or if a tenant's own rows go missing.
 *
 * ```ts
 * await assertTenantIsolation({ tenants: [storeA, storeB], run: () => listOrders() })
 * ```
 */
export async function assertTenantIsolation(opts: TenantIsolationOptions): Promise<void> {
  if (opts.tenants.length < 2) throw new TypeError('assertTenantIsolation() needs at least two tenants.')
  const models = opts.models ?? tenantModels()
  const leaks: string[] = []
  for (const tenant of opts.tenants) {
    const who = `tenant ${String(tenant.pk)}`
    for (const model of models) {
      const name = model._meta.objectName
      const field = tenantFieldOf(model)
      if (!field) {
        leaks.push(`${name} is not a tenant-scoped model`)
        continue
      }
      const rows = (await runAsTenant(tenant, () => model._defaultManager.all().fetch())) as BaseModel[]
      const foreign = rows.filter((r) => !samePk(ownerOf(r), tenant.pk))
      if (foreign.length) {
        leaks.push(`${name}.objects as ${who} returned ${foreign.length} row(s) of other tenants`)
      }
      const expected = await withoutTenant(() =>
        model._baseManager
          .getQueryset()
          .filter({ [field]: tenant.pk })
          .count(),
      )
      if (rows.length - foreign.length !== expected) {
        leaks.push(
          `${name}.objects as ${who} returned ${rows.length - foreign.length} of its ${expected} row(s)`,
        )
      }
    }
    if (opts.run) {
      const run = opts.run
      const found: BaseModel[] = []
      collectInstances(await runAsTenant(tenant, () => run(tenant)), found)
      for (const obj of found) {
        if (!samePk(ownerOf(obj), tenant.pk)) {
          leaks.push(
            `run() as ${who} returned ${(obj.constructor as ModelClass)._meta.objectName} ${String(obj.pk)} of tenant ${String(ownerOf(obj))}`,
          )
        }
      }
    }
  }
  if (leaks.length) throw new TenantLeakError(leaks)
}
