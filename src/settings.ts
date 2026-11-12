import { apps, ImproperlyConfigured, LookupError, tryGetContext } from '@ghuri/core'
import { isModelClass, type ModelClass } from '@ghuri/orm'
import type { TenantResolverEntry } from './resolvers'

export interface TenantsSettings {
  /** The tenant model: `'stores.Store'` or the class. Used by `TenantModel` foreign keys and the resolvers. */
  MODEL?: string | ModelClass
  /** Resolvers `TenantMiddleware` tries in order; the first that returns a tenant wins. */
  RESOLVERS?: TenantResolverEntry[]
  /** Answer 404 when no resolver finds a tenant (default false: the request runs with no tenant). */
  REQUIRED?: boolean
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    /** `@ghuri/tenants` configuration. */
    TENANTS?: TenantsSettings
  }
}

/** `settings.TENANTS` of the current context (`{}` when unset or outside a context). */
export function tenantSettings(): TenantsSettings {
  return (tryGetContext()?.settings.TENANTS as TenantsSettings | undefined) ?? {}
}

/** The tenant model class from `TENANTS.MODEL`. Throws `ImproperlyConfigured` when unset or not installed. */
export function getTenantModel<M extends ModelClass = ModelClass>(): M {
  const model = tenantSettings().MODEL
  if (!model) {
    throw new ImproperlyConfigured(
      "TENANTS.MODEL is not set: set it to the tenant model ('stores.Store'), or pass `to` to tenantModel().",
    )
  }
  if (typeof model !== 'string') {
    if (!isModelClass(model)) throw new ImproperlyConfigured('TENANTS.MODEL is not a model class.')
    return model as M
  }
  let found: unknown
  try {
    found = apps.getModel(model)
  } catch (err) {
    if (err instanceof LookupError) {
      throw new ImproperlyConfigured(`TENANTS.MODEL refers to model '${model}' that has not been installed`)
    }
    throw new ImproperlyConfigured("TENANTS.MODEL must be of the form 'app_label.model_name'", { cause: err })
  }
  if (!isModelClass(found)) throw new ImproperlyConfigured(`TENANTS.MODEL '${model}' is not a model.`)
  return found as M
}
