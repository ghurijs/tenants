import {
  type BaseModel,
  CASCADE,
  type FieldMap,
  ForeignKey,
  Manager,
  Model,
  type ModelBaseClass,
  type ModelClass,
  type ModelMeta,
  m2mChanged,
  Q,
  QuerySet,
  UUIDField,
} from '@ghuri/orm'
import { currentFrame, requireTenant, samePk, tenantMode } from './context'
import { CrossTenantError } from './errors'
import { getTenantModel } from './settings'
import { uuid7 } from './uuid'

const TENANT_FIELD = Symbol.for('ghuri.tenants.field')
const RAW_STATE = Symbol('ghuri.tenants.rawState')
const SCOPED_CACHE = Symbol('ghuri.tenants.scopedState')
/** The tenant filters `TenantQuerySet` adds itself (never copied into chained QuerySets). */
const SCOPE_FILTERS = new WeakSet<object>()

type SaveOptions = Parameters<BaseModel['save']>[0]

/** Name of the tenant foreign key of a tenant-scoped model (`'store'`), or `undefined` for other models. */
export function tenantFieldOf(model: unknown): string | undefined {
  if (typeof model !== 'function') return undefined
  return (model as any)[TENANT_FIELD] as string | undefined
}

/** Is `model` a tenant-scoped model (built with `TenantModel()` / a `tenantModel()` factory)? */
export function isTenantModel(model: unknown): boolean {
  return tenantFieldOf(model) !== undefined
}

function tenantAttname(model: ModelClass, field: string): string {
  return model._meta.getForwardField(field)?.attname ?? `${field}Id`
}

// ---- QuerySet ----------------------------------------------------------------------------------------------

/**
 * QuerySet of a tenant-scoped model. The tenant filter is added when the query runs (or is compiled as a
 * subquery), not when it is built, so `static queryset = Product.objects.all()` on a viewset is fine at import
 * time and is scoped to each request's tenant.
 *
 * - tenant active: `WHERE <tenant> = <current tenant>` is added
 * - inside `withoutTenant()`: no filter
 * - no tenant: running the query throws `TenantNotSet`; compiled as a subquery it matches nothing
 */
export class TenantQuerySet<T = any> extends QuerySet<T> {
  constructor(model: ModelClass, state?: any) {
    super(model, state)
    const raw = (this as any).state
    Object.defineProperty(this, RAW_STATE, { value: raw })
    Object.defineProperty(this, 'state', {
      get: () => this.scopedState(),
      enumerable: true,
      configurable: true,
    })
  }

  private get tenantField(): string {
    return tenantFieldOf(this.model) as string
  }

  private scopedState(): any {
    const raw = (this as any)[RAW_STATE]
    const mode = tenantMode()
    if (mode === 'bypass') return raw
    const field = tenantFieldOf(raw.model) as string
    const value = mode === 'tenant' ? requireTenant().pk : null
    const key = mode === 'tenant' ? `t:${String(value)}` : 'none'
    const cached = (this as any)[SCOPED_CACHE] as [string, any] | undefined
    if (cached && cached[0] === key) return cached[1]
    // No tenant: `<tenant> IS NULL` never matches (the tenant foreign key is NOT NULL), so the query fails closed
    // even where it is compiled without running (subqueries).
    const scope = Q({ [field]: value })
    SCOPE_FILTERS.add(scope)
    const scoped = { ...raw, where: [...raw.where, scope] }
    Object.defineProperty(this, SCOPED_CACHE, { value: [key, scoped], configurable: true, writable: true })
    return scoped
  }

  // Chain from the unscoped state, and drop the scope filter that `filter()` / `exclude()` copy from `state.where`,
  // so the tenant of one request (or the "no tenant" filter) is never baked into a derived QuerySet.
  protected override chain<R = T>(patch: Record<string, unknown>): QuerySet<R> {
    const Ctor = this.constructor as new (model: ModelClass, state: any) => QuerySet<R>
    const clean = Array.isArray(patch.where)
      ? { ...patch, where: patch.where.filter((q: object) => !SCOPE_FILTERS.has(q)) }
      : patch
    return new Ctor(this.model, { ...(this as any)[RAW_STATE], ...clean })
  }

  private assertReady(op: string): void {
    if (tenantMode() === 'none') requireTenant(`${op} on ${this.model._meta.objectName}`)
  }

  override async fetch(): Promise<T[]> {
    this.assertReady('Querying')
    return super.fetch()
  }

  override async count(): Promise<number> {
    this.assertReady('count()')
    return super.count()
  }

  override async exists(): Promise<boolean> {
    this.assertReady('exists()')
    return super.exists()
  }

  override async aggregate(spec: any): Promise<any> {
    this.assertReady('aggregate()')
    return super.aggregate(spec)
  }

  override async delete(): Promise<[number, Record<string, number>]> {
    this.assertReady('delete()')
    return super.delete()
  }

  override async update(values: Record<string, unknown>): Promise<number> {
    this.assertReady('update()')
    if (tenantMode() === 'tenant') {
      const model = this.model
      const field = this.tenantField
      const attname = tenantAttname(model, field)
      const tenantPk = requireTenant().pk
      for (const key of [field, attname]) {
        if (key in values && !samePk(pkOf(values[key]), tenantPk)) {
          throw new CrossTenantError(`update() cannot move ${model._meta.objectName} rows to another tenant.`)
        }
      }
      await verifyForeignKeys(model, [values], tenantPk, { byName: true })
    }
    return super.update(values)
  }

  override async bulkCreate(objs: T[], opts?: any): Promise<T[]> {
    if (objs.length && tenantMode() !== 'bypass') {
      const model = this.model
      const tenantPk = requireTenant(`bulkCreate() on ${model._meta.objectName}`).pk
      const attname = tenantAttname(model, this.tenantField)
      for (const o of objs as any[]) {
        if (o[attname] === null || o[attname] === undefined) o[attname] = tenantPk
        else if (!samePk(o[attname], tenantPk)) {
          throw new CrossTenantError(`bulkCreate() got a ${model._meta.objectName} of another tenant.`)
        }
      }
      await verifyForeignKeys(model, objs as any[], tenantPk)
    }
    return super.bulkCreate(objs, opts)
  }

  override async bulkUpdate(objs: T[], fields: string[], opts?: { batchSize?: number }): Promise<number> {
    if (objs.length && tenantMode() !== 'bypass') {
      const model = this.model
      const name = model._meta.objectName
      const tenantPk = requireTenant(`bulkUpdate() on ${name}`).pk
      const field = this.tenantField
      const attname = tenantAttname(model, field)
      if (fields.includes(field) || fields.includes(attname)) {
        throw new CrossTenantError(`bulkUpdate() cannot change the tenant of ${name} rows.`)
      }
      for (const o of objs as any[]) {
        if (!samePk(o[attname], tenantPk))
          throw new CrossTenantError(`bulkUpdate() got a ${name} of another tenant.`)
      }
      // The UPDATE matches rows by primary key only: make sure every key belongs to the current tenant.
      const ids = [...new Set((objs as any[]).map((o) => String(o.pk)))]
      const owned = await this.filter({ pk__in: ids } as any).count()
      if (owned !== ids.length) throw new CrossTenantError(`bulkUpdate() got a ${name} of another tenant.`)
      await verifyForeignKeys(model, objs as any[], tenantPk, { only: fields })
    }
    return super.bulkUpdate(objs, fields, opts)
  }
}

/** Default manager of tenant-scoped models: its QuerySets are filtered to the current tenant. */
export class TenantManager<T = any> extends Manager<T> {
  override getQueryset(): QuerySet<T> {
    this.assertBound()
    return new TenantQuerySet<T>(this.model)
  }
}

// ---- write checks ------------------------------------------------------------------------------------------

function pkOf(v: unknown): unknown {
  if (v && typeof v === 'object' && typeof (v as any).constructor?._meta === 'object') return (v as any).pk
  return v
}

/**
 * Check that every foreign key of `objs` that targets a tenant-scoped model points at a row of `tenantPk`.
 * One COUNT per foreign key field; values already checked in the current frame are skipped.
 */
async function verifyForeignKeys(
  model: ModelClass,
  objs: Array<Record<string, unknown>>,
  tenantPk: unknown,
  opts: { only?: string[]; byName?: boolean } = {},
): Promise<void> {
  const ownField = tenantFieldOf(model)
  const frame = currentFrame()
  for (const f of model._meta.concreteFields) {
    if (!(f instanceof ForeignKey) || f.name === ownField) continue
    if (opts.only && !opts.only.includes(f.name) && !opts.only.includes(f.attname)) continue
    let target: ModelClass
    try {
      target = f.relatedModel
    } catch {
      continue
    }
    const targetField = tenantFieldOf(target)
    if (!targetField) continue
    const values = new Set<string>()
    const raw: unknown[] = []
    for (const o of objs) {
      let v: unknown
      if (opts.byName) {
        if (f.name in o) v = o[f.name]
        else if (f.attname in o) v = o[f.attname]
        else continue
        if (v && typeof v === 'object' && typeof (v as any).constructor?._meta === 'object')
          v = (v as any)[f.targetField.attname]
        else if (v && typeof v === 'object') continue // expressions (F(), …) are checked by the database
      } else v = o[f.attname]
      if (v === null || v === undefined) continue
      if (!values.has(String(v))) raw.push(v)
      values.add(String(v))
    }
    if (!values.size) continue
    const cacheKey = `${String(tenantPk)}|${target._meta.label}:${f.targetField.name}`
    const seen = frame?.verified.get(cacheKey)
    const todo = raw.filter((v) => !seen?.has(String(v)))
    if (!todo.length) continue
    const n = await target._baseManager
      .getQueryset()
      .filter({ [`${f.targetField.name}__in`]: todo, [targetField]: tenantPk })
      .count()
    if (n !== todo.length) {
      throw new CrossTenantError(
        `${model._meta.objectName}.${f.name} points to a ${target._meta.objectName} of another tenant (or one that does not exist).`,
      )
    }
    if (frame) {
      const set = seen ?? new Set<string>()
      for (const v of todo) set.add(String(v))
      frame.verified.set(cacheKey, set)
    }
  }
}

/** Called by `save()` of tenant-scoped models before the row is written. */
async function checkSave(obj: BaseModel, field: string): Promise<void> {
  if (tenantMode() === 'bypass') return
  const model = obj.constructor as ModelClass
  const meta = model._meta
  const tenant = requireTenant(`Saving a ${meta.objectName}`)
  const attname = tenantAttname(model, field)
  const current = (obj as any)[attname]
  // An assigned-but-unsynced related tenant object wins over the raw id (save() syncs it the same way).
  const cached = obj._state.fieldsCache.get(field) as BaseModel | null | undefined
  const effective = cached ? cached.pk : current
  if (effective === null || effective === undefined) {
    ;(obj as any)[attname] = tenant.pk
    obj._state.fieldsCache.set(field, tenant as unknown as BaseModel)
  } else if (!samePk(effective, tenant.pk)) {
    throw new CrossTenantError(`Cannot save a ${meta.objectName} of another tenant.`)
  }
  // A new object with an explicit key and no key default is saved with UPDATE … WHERE pk = ?: make sure that row,
  // if it exists, is ours.
  const pk = (obj as any)[meta.pk.attname]
  if (obj._state.adding && pk !== null && pk !== undefined && !meta.pk.hasDefault()) {
    const owners = await model._baseManager
      .getQueryset()
      .filter({ pk })
      .valuesList(attname, { flat: true })
      .fetch()
    if (owners.length && !samePk(owners[0], tenant.pk)) {
      throw new CrossTenantError(`Cannot save a ${meta.objectName} of another tenant.`)
    }
  }
  await verifyForeignKeys(model, [obj as unknown as Record<string, unknown>], tenant.pk)
}

// M2M links: both sides must belong to the current tenant.
m2mChanged.connect(
  async ({ instance, action, model, pkSet }) => {
    if (action !== 'pre_add' || !pkSet?.size || tenantMode() === 'bypass') return
    const source = instance.constructor as ModelClass
    const sourceField = tenantFieldOf(source)
    const targetField = tenantFieldOf(model)
    if (!sourceField && !targetField) return
    const tenant = requireTenant(`Adding ${model._meta.objectName} links`)
    if (sourceField && !samePk((instance as any)[tenantAttname(source, sourceField)], tenant.pk)) {
      throw new CrossTenantError(`Cannot link a ${source._meta.objectName} of another tenant.`)
    }
    if (targetField) {
      const ids = [...pkSet]
      const n = await model._baseManager
        .getQueryset()
        .filter({ pk__in: ids, [targetField]: tenant.pk })
        .count()
      if (n !== ids.length) {
        throw new CrossTenantError(`Cannot link a ${model._meta.objectName} of another tenant.`)
      }
    }
  },
  { uid: 'ghuri.tenants.m2mGuard' },
)

// ---- TenantModel factory ---------------------------------------------------------------------------------

export interface TenantModelFactoryOptions<N extends string, M extends ModelClass, U extends boolean> {
  /** Name of the tenant foreign key added to every model (default `'tenant'`; column `<name>_id`). */
  field?: N
  /** The tenant model, or a thunk (default: `TENANTS.MODEL`, resolved when the relation is first used). */
  to?: M | (() => M)
  /** Reverse accessor on the tenant model (default: Django's `<model>Set`; `'+'` hides it). */
  relatedName?: string
  /** Give every model a UUIDv7 primary key `id` instead of an auto-increment integer. */
  uuidPk?: U
}

/** The class side every tenant-scoped model inherits: `objects` (scoped) and `unscoped` (every tenant). */
export type TenantModelBase = typeof BaseModel & {
  /** Every tenant's rows, no checks. For platform code; prefer `withoutTenant()`. */
  unscoped: Manager<any>
}

type TenantFields<N extends string, M extends ModelClass, U extends boolean> = {
  [K in N]: ForeignKey<M, { onDelete: typeof CASCADE }>
} & (U extends true ? { id: UUIDField<{ primaryKey: true }> } : {})

/** A `Model()`-like factory whose models are scoped to the current tenant. */
export type TenantModelFactory<N extends string, M extends ModelClass, U extends boolean> = <
  F extends FieldMap,
>(
  fields: F,
  options?: { meta?: ModelMeta },
) => ModelBaseClass<F & TenantFields<N, M, U>, TenantModelBase>

/**
 * Build a `TenantModel` factory for your project:
 *
 * ```ts
 * export const StoreModel = tenantModel({ field: 'store', to: () => Store, uuidPk: true })
 * export class Product extends StoreModel({ title: new CharField({ maxLength: 255 }) }) {}
 * ```
 *
 * Models get a `<field>` foreign key to the tenant (NOT NULL, indexed, `CASCADE`), `objects` filtered to the
 * current tenant, `unscoped` for platform code, and checks on `save()`, `bulkCreate()`, `bulkUpdate()`,
 * `update()` and M2M `add()` that keep rows and foreign keys inside one tenant.
 */
export function tenantModel<
  N extends string = 'tenant',
  M extends ModelClass = ModelClass,
  U extends boolean = false,
>(options: TenantModelFactoryOptions<N, M, U> = {}): TenantModelFactory<N, M, U> {
  const field = (options.field ?? 'tenant') as N
  const to = options.to ?? (() => getTenantModel<M>())
  const base: FieldMap = {
    [field]: new ForeignKey(to as any, {
      onDelete: CASCADE,
      ...(options.relatedName ? { relatedName: options.relatedName } : {}),
    }),
  }
  if (options.uuidPk) base.id = new UUIDField({ primaryKey: true, default: uuid7, editable: false })

  class TenantBase extends Model(base) {
    static Meta: ModelMeta = { abstract: true }
    static objects = new TenantManager()
    static unscoped = new Manager()

    override async save(opts?: SaveOptions): Promise<void> {
      await checkSave(this, field)
      return super.save(opts)
    }
  }
  Object.defineProperty(TenantBase, TENANT_FIELD, { value: field })

  return (<F extends FieldMap>(fields: F, opts: { meta?: ModelMeta } = {}) =>
    Model(fields, { extends: TenantBase as any, meta: opts.meta })) as unknown as TenantModelFactory<N, M, U>
}

/**
 * Tenant-scoped model base with a `tenant` foreign key to `TENANTS.MODEL`:
 *
 * ```ts
 * export class Product extends TenantModel({ title: new CharField({ maxLength: 255 }) }) {}
 * await Product.objects.all()   // the current tenant's products only
 * ```
 *
 * Use `tenantModel({ field: 'store', ... })` for another field name or UUID primary keys.
 */
export const TenantModel: TenantModelFactory<'tenant', ModelClass, false> = tenantModel()
