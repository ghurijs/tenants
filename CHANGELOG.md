# Changelog

## 0.1.0-alpha.0

Initial alpha.

- `tenantModel()` / `TenantModel`: tenant-scoped models with a tenant foreign key, `objects` (scoped),
  `unscoped`, and optional UUIDv7 primary keys.
- `TenantQuerySet`: the tenant filter is added at run time (also in subqueries); queries fail closed with
  `TenantNotSet` when no tenant is active.
- Write checks on `save`, `create`, `update`, `bulkCreate`, `bulkUpdate` and M2M `add`: rows and foreign keys stay
  inside one tenant (`CrossTenantError`, an HTTP 403).
- `objects` and `unscoped` are bound lazily per concrete model, so `Product.objects.all()` works before the model
  is prepared (viewset `queryset` attributes at import time).
- Tested with `@ghuri/graphql`, `@ghuri/rest` viewsets and `@ghuri/agents` `ModelTools`.
- `tenantModel({ extends })`: inherit an abstract model such as `AbstractBaseUser` (per-tenant customers); its
  `objects` manager class is kept and scoped. Needs `@ghuri/orm` with manager shadowing and `@ghuri/auth` with
  `JWTToken.userModel()` for per-tenant JWTs (see the README).
- `runAsTenant`, `withoutTenant`, `activateTenant`, `currentTenant`, `requireTenant`, `tenantMode`.
- `TenantMiddleware` with `HeaderResolver`, `SubdomainResolver`, `HostResolver` and function resolvers;
  `TENANTS` settings (`MODEL`, `RESOLVERS`, `REQUIRED`).
- `tenantCache()`: per-tenant cache key prefix.
- `uuid7()` / `uuid7Time()`.
- `@ghuri/tenants/testing`: `assertTenantIsolation()` and `TenantLeakError`.
