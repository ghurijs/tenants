# Changelog

## 0.1.0-alpha.1

- Fix: `objects` and `unscoped` are bound lazily per concrete model, so `Product.objects.all()` works before the
  model is prepared (viewset `queryset` attributes at import time). In 0.1.0-alpha.0 it returned the abstract base's
  unbound manager.
- `CrossTenantError` extends `PermissionDenied`, so it reaches clients as HTTP 403 instead of 500.
- `tenantModel({ extends })`: inherit an abstract model such as `AbstractBaseUser` for per-tenant customers; its
  `objects` manager class is kept and scoped. Requires `@ghuri/orm` 0.1.0-alpha.3 (manager shadowing; the peer
  range now asks for it), and `@ghuri/auth` 0.1.0-alpha.4 for per-tenant JWTs (see the README).
- Tested with `@ghuri/graphql`, `@ghuri/rest` viewsets, `@ghuri/agents` `ModelTools` and per-tenant customers.

## 0.1.0-alpha.0

Initial alpha.

- `tenantModel()` / `TenantModel`: tenant-scoped models with a tenant foreign key, `objects` (scoped),
  `unscoped`, and optional UUIDv7 primary keys.
- `TenantQuerySet`: the tenant filter is added at run time (also in subqueries); queries fail closed with
  `TenantNotSet` when no tenant is active.
- Write checks on `save`, `create`, `update`, `bulkCreate`, `bulkUpdate` and M2M `add`: rows and foreign keys stay
  inside one tenant (`CrossTenantError`).
- `runAsTenant`, `withoutTenant`, `activateTenant`, `currentTenant`, `requireTenant`, `tenantMode`.
- `TenantMiddleware` with `HeaderResolver`, `SubdomainResolver`, `HostResolver` and function resolvers;
  `TENANTS` settings (`MODEL`, `RESOLVERS`, `REQUIRED`).
- `tenantCache()`: per-tenant cache key prefix.
- `uuid7()` / `uuid7Time()`.
- `@ghuri/tenants/testing`: `assertTenantIsolation()` and `TenantLeakError`.
