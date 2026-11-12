# @ghuri/tenants

Shared-schema multi-tenancy for [Ghuri](https://github.com/ghurijs/ghuri). Every tenant-scoped row carries a
tenant foreign key, and Ghuri scopes managers, QuerySets and writes to the current tenant. When no tenant is set,
queries **fail closed** instead of returning every tenant's rows.

Works the same on D1, SQLite and Postgres: one database, one migration run, and the same models after a
`dumpdata` / `loaddata` move from D1 to Postgres.

> Status: alpha (`0.1.0-alpha.0`). APIs may change.

```sh
npm install @ghuri/tenants@next
```

## Contents

1. [Quick start](#1-quick-start)
2. [Tenant-scoped models](#2-tenant-scoped-models)
3. [The current tenant](#3-the-current-tenant)
4. [Finding the tenant of a request](#4-finding-the-tenant-of-a-request)
5. [What is checked](#5-what-is-checked)
6. [Cache, UUIDv7 keys, GraphQL, REST and agents](#6-cache-uuidv7-keys-graphql-rest-and-agents)
7. [Testing for leaks](#7-testing-for-leaks)
8. [Limits](#8-limits)

## 1. Quick start

```ts
// src/stores/models.ts
import { CharField, Model, SlugField } from '@ghuri/orm'
import { tenantModel } from '@ghuri/tenants'

export class Store extends Model({
  name: new CharField({ maxLength: 100 }),
  slug: new SlugField({ unique: true }),
  domain: new CharField({ maxLength: 200, null: true, blank: true }),
  storefrontToken: new CharField({ maxLength: 64, unique: true }),
}) {}

// One factory for the project: a `store` foreign key and UUIDv7 primary keys on every model.
export const StoreModel = tenantModel({ field: 'store', to: () => Store, uuidPk: true })
```

```ts
// src/catalog/models.ts
import { CharField, SlugField } from '@ghuri/orm'
import { StoreModel } from '../stores/models'

export class Product extends StoreModel({
  title: new CharField({ maxLength: 255 }),
  handle: new SlugField(),
}) {
  static Meta = { uniqueTogether: [['store', 'handle']] }
}
```

```ts
// src/settings.ts
import { HeaderResolver, HostResolver, SubdomainResolver, TenantMiddleware } from '@ghuri/tenants'

export default defineSettings((env) => ({
  // …
  MIDDLEWARE: [SecurityMiddleware, CommonMiddleware, TenantMiddleware /* , … */],
  TENANTS: {
    MODEL: 'stores.Store',
    RESOLVERS: [
      new HeaderResolver({ header: 'X-Storefront-Token', field: 'storefrontToken' }),
      new SubdomainResolver({ domain: 'myghuri.com', exclude: ['www', 'api', 'admin'] }),
      new HostResolver({ field: 'domain' }),
    ],
  },
}))
```

```ts
await Product.objects.all()                       // this request's store only
await Product.objects.create({ title: 'Shirt', handle: 'shirt' }) // `store` is filled in
await Product.unscoped.count()                    // every store (platform code only)
```

## 2. Tenant-scoped models

`tenantModel(options)` returns a `Model()`-like factory. Each model built with it gets:

| | |
|---|---|
| `<field>` | `ForeignKey` to the tenant, NOT NULL, indexed, `onDelete: CASCADE` (column `<field>_id`) |
| `objects` | `TenantManager`: QuerySets filtered to the current tenant |
| `unscoped` | A plain `Manager`: every tenant, no checks |
| `save()` | Fills in and checks the tenant and foreign keys (see [§5](#5-what-is-checked)) |

Options:

| Option | Default | |
|---|---|---|
| `field` | `'tenant'` | Name of the tenant foreign key |
| `to` | `TENANTS.MODEL` | The tenant model or a thunk (`() => Store`) |
| `relatedName` | Django's `<model>Set` | Reverse accessor on the tenant model; `'+'` hides it |
| `uuidPk` | `false` | Add `id: UUIDField({ primaryKey: true, default: uuid7 })` |
| `extends` | none | Abstract model to inherit from (e.g. `AbstractBaseUser`); its `objects` manager class is kept, scoped |

`TenantModel` is the ready-made factory with `field: 'tenant'` and the target from `TENANTS.MODEL`. Start every
index and unique constraint with the tenant field (`uniqueTogether: [['store', 'handle']]`).

The tenant model itself (`Store`) is an ordinary model, not tenant-scoped.

### Per-tenant users (a shop's customers)

Shoppers belong to one store, so they are a tenant-scoped model, not `AUTH_USER_MODEL`. Extend `AbstractBaseUser`
for passwords, and give them their own JWT type with `@ghuri/auth`'s `userModel()` hook:

```ts
import { AbstractBaseUser, AccessToken, RefreshToken } from '@ghuri/auth'
import { JWTAuthentication } from '@ghuri/auth/rest'

const CustomerModel = tenantModel({ field: 'store', to: () => Store, uuidPk: true, extends: AbstractBaseUser })

export class Customer extends CustomerModel({ email: new EmailField(), isActive: new BooleanField({ default: true }) }) {
  static Meta = { uniqueTogether: [['store', 'email']] }
  static USERNAME_FIELD = 'email'
}

export class CustomerAccessToken extends AccessToken {
  static tokenType = 'customer_access'
  static userModel() { return Customer }
}
export class CustomerRefreshToken extends RefreshToken {
  static tokenType = 'customer_refresh'
  static accessTokenClass = CustomerAccessToken
  static userModel() { return Customer }
}
export class CustomerJWTAuthentication extends JWTAuthentication {
  tokenClasses = [CustomerAccessToken]
}
```

`Customer.objects` is a scoped `UserManager`, so a login looks the email up in the request's store only. A token is
read back through the same scoped manager, so a customer token issued by one store is rejected on another. Its own
`tokenType` means it is never accepted as a platform-user token, and vice versa. Use `TokenRefreshView` and
`TokenBlacklistView` with `tokenClass = CustomerRefreshToken` for refresh and logout.

## 3. The current tenant

| Function | |
|---|---|
| `currentTenant()` | The active tenant, or `null` |
| `requireTenant()` | The active tenant; throws `TenantNotSet` when there is none |
| `runAsTenant(tenant, fn)` | Run `fn` as `tenant`: queue consumers, cron, CLI commands, tests |
| `withoutTenant(fn)` | Run `fn` with scoping off: tenant-scoped managers see every tenant, writes are not checked |
| `activateTenant(tenant)` | Set a tenant outside any `runAsTenant()` (scripts, REPL, tests); returns `restore()` |
| `tenantMode()` | `'tenant'`, `'bypass'` (inside `withoutTenant`) or `'none'` |

They nest; the innermost wins. `TenantMiddleware` runs each request inside `runAsTenant()`.

```ts
// A queue consumer
export async function syncInventory(job: { storeId: number }) {
  const store = await Store.objects.get({ pk: job.storeId })
  await runAsTenant(store, async () => {
    for await (const p of Product.objects.iterator()) { /* … */ }
  })
}
```

## 4. Finding the tenant of a request

`TenantMiddleware` tries `TENANTS.RESOLVERS` in order and stops at the first tenant. A resolver returns the
tenant, `null` (not tenant traffic, so the next resolver is tried), or throws `TenantNotFound` (404).

| Resolver | Matches | Unknown value |
|---|---|---|
| `HeaderResolver({ header = 'X-Tenant', field = 'pk' })` | A request header, e.g. a storefront token | 404 |
| `SubdomainResolver({ domain, field = 'slug', exclude })` | `amarshop.myghuri.com` → `slug = 'amarshop'` | 404; other hosts are `null` |
| `HostResolver({ field = 'domain' })` | The whole host, for custom domains | `null` |
| `async (c) => tenant \| null` | Anything | Your choice |

Every resolver takes `filter` (`{ isActive: true }`) and `model` (default `TENANTS.MODEL`). With no tenant found
the request runs without one, so platform routes keep working, unless `TENANTS.REQUIRED` (or
`new TenantMiddleware({ required: true })`) asks for a 404. The tenant is also `c.get('tenant')`.

A resolver only says which tenant the request is for. Whether the signed-in user may act for that tenant is a
permission check: compare `request.user` with your membership model in a permission class.

## 5. What is checked

With a tenant active:

| Operation | Behaviour |
|---|---|
| Reads (`fetch`, `get`, `count`, `exists`, `aggregate`, `values`, iteration) | `WHERE <tenant> = <current>` is added |
| Subqueries (`filter({ pk__in: Product.objects.values('id') })`) | Scoped the same way |
| Reverse relations, M2M managers, GraphQL, REST viewsets, agent tools | Scoped, because they read through `objects` |
| `save()`, `create()` | Fills an empty tenant; refuses another tenant's object; refuses an explicit key that names another tenant's row |
| Foreign keys to tenant-scoped models | Must point to the same tenant (checked on `save`, `create`, `bulkCreate`, `bulkUpdate`, `update`) |
| `update(values)` | Scoped; refuses changing the tenant or pointing foreign keys at another tenant |
| `bulkCreate()` | Fills and checks the tenant and foreign keys |
| `bulkUpdate()` | Refuses objects of another tenant and changing the tenant field |
| `delete()` | Scoped; cascades follow the same-tenant foreign keys |
| M2M `add()` | Both sides must belong to the current tenant |

With **no** tenant (and not inside `withoutTenant()`), running a query or a write on a tenant-scoped model throws
`TenantNotSet`, and a tenant QuerySet compiled as a subquery matches nothing.

The tenant filter is added when a QuerySet runs, not when it is built. So `static queryset = Product.objects.all()`
on a viewset is fine at import time and is scoped to each request.

Each foreign key check is one `COUNT` query per field per write. Values already checked are remembered for the
rest of the request or `runAsTenant()` block.

## 6. Cache, UUIDv7 keys, GraphQL, REST and agents

**Cache.** `tenantCache(alias = 'default')` wraps a configured cache and prefixes every key with `t:<tenant pk>:`.
`clear()` deletes only this tenant's keys on backends that clear by prefix (memory, KV).

```ts
const cache = tenantCache()
await cache.getOrSet('menu', () => buildMenu(), 300)
```

**UUIDv7.** `uuid7()` returns a time-ordered UUID (RFC 9562), and `uuid7Time(id)` reads its timestamp back. With
`uuidPk: true`, keys stay unique across databases, so one tenant can later move to its own database without
clashes.

**GraphQL, REST and agents.** They all read through the model's default manager, so they are scoped with no
per-type code:

- `@ghuri/graphql`: root fields, connections, relations and `node(id:)`; another tenant's `node(id:)` is `null`.
- `@ghuri/rest`: viewsets (`queryset = Product.objects.all()` at import time is fine); another tenant's object is a
  404, and a serializer foreign key to another tenant's row fails validation (400), because related fields look
  up through the scoped `objects` too.
- `@ghuri/agents`: `ModelTools` run as the current tenant (tested); the MCP endpoint runs them inside the request,
  after `TenantMiddleware`.

`CrossTenantError` is an HTTP 403 (`PermissionDenied`) when it reaches an error handler; `TenantNotSet` is a 500,
because it means code ran without a tenant where one was required.

## 7. Testing for leaks

```ts
import { assertTenantIsolation } from '@ghuri/tenants/testing'

it('never leaks between stores', async () => {
  const [a, b] = await makeTwoStoresWithData()
  await assertTenantIsolation({
    tenants: [a, b],
    run: () => listOrdersForDashboard(),   // your own code, run once as each tenant
  })
})
```

`assertTenantIsolation()` runs `objects.all()` of every registered tenant-scoped model (or `models`) as each
tenant. It also runs `run` as each tenant and searches what comes back (arrays, objects, Maps, Sets). It throws
`TenantLeakError` when another tenant's row comes back, or when a tenant's own rows go missing.

## 8. Limits

- `unscoped`, `_baseManager`, raw SQL and `getDrizzle()` are not scoped.
- A foreign key from a tenant-scoped model to the tenant model itself, other than the tenant field (for example
  `referrerStore`), is not checked.
- A reverse FK `add()` (`collection.products.add(p)`) updates rows by primary key. It only accepts saved instances,
  which came from scoped queries unless you loaded them through `unscoped`.
- Not yet: database routers for moving one tenant to its own database, `dumpdata --tenant`, Postgres row-level
  security, and a `TenantMember` permission class for `@ghuri/rest`.

## License

MIT
