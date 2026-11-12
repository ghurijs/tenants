# Changelog

## 0.1.0-alpha.2

- **Behaviour change:** `requestHost()`, and so `SubdomainResolver` and `HostResolver`, no longer trust
  `X-Forwarded-Host` unconditionally. They now read the host exactly as `@ghuri/core`'s `getHost()` does (the
  host the CSRF and `ALLOWED_HOSTS` checks use): the request URL's host, which Workers and `@ghuri/core/node`
  build from the `Host` header, and `X-Forwarded-Host` only when the `USE_X_FORWARDED_HOST` setting is true, as
  in Django. Before, any client could choose which tenant a request resolved to by sending `X-Forwarded-Host`,
  and the tenant host and the CSRF host could disagree. If your proxy sets `X-Forwarded-Host` and you relied on
  it, set `USE_X_FORWARDED_HOST: true` (only behind a proxy that overwrites the header). Tests that set a `Host`
  header on a test client request should put the host in the URL instead (`client.get('http://shop.a.test/')`)
  or in the client's `baseUrl`. The port, a trailing dot and case are still stripped.
- Fix: `uuid7()` is monotonic within a process (RFC 9562 §6.2, method 1). A 42-bit counter in `rand_a` and the
  high bits of `rand_b`, seeded randomly each new millisecond, orders ids made in the same millisecond, so
  ordering by `id` keeps insertion order for rows created together. When the clock goes backwards the last
  timestamp is reused; on counter overflow (over 2^41 ids in one millisecond) the timestamp field is advanced
  by one, so `uuid7Time()` can be slightly ahead of the wall clock in those cases. The format, version and
  variant bits are unchanged.

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
