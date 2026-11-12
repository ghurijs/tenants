// @ghuri/tenants — shared-schema multi-tenancy for Ghuri: every tenant-scoped row carries a tenant foreign key,
// and managers, QuerySets and writes are scoped to the current tenant, failing closed when there is none.

export { type TenantCache, tenantCache } from './cache'
export {
  activateTenant,
  currentTenant,
  requireTenant,
  runAsTenant,
  samePk,
  type TenantLike,
  type TenantMode,
  tenantMode,
  withoutTenant,
} from './context'
export { CrossTenantError, TenantNotFound, TenantNotSet } from './errors'
export { TenantMiddleware, type TenantMiddlewareOptions } from './middleware'
export {
  isTenantModel,
  TenantManager,
  TenantModel,
  type TenantModelBase,
  type TenantModelFactory,
  type TenantModelFactoryOptions,
  TenantQuerySet,
  tenantFieldOf,
  tenantModel,
} from './models'
export {
  HeaderResolver,
  HostResolver,
  type LookupOptions,
  requestHost,
  runResolver,
  SubdomainResolver,
  type TenantResolver,
  type TenantResolverEntry,
} from './resolvers'
export { getTenantModel, type TenantsSettings, tenantSettings } from './settings'
export { uuid7, uuid7Time } from './uuid'
