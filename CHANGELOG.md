# Changelog

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
