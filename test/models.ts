import {
  CharField,
  ForeignKey,
  ManyToManyField,
  Model,
  type RelatedManager,
  SET_NULL,
  SlugField,
} from '@ghuri/orm'
import { TenantModel, tenantModel } from '../src'

export class Store extends Model({
  name: new CharField({ maxLength: 100 }),
  slug: new SlugField({ unique: true }),
  domain: new CharField({ maxLength: 200, null: true, blank: true }),
  token: new CharField({ maxLength: 64, null: true, blank: true }),
}) {
  static Meta = { appLabel: 'shop' }
}

/** The e-commerce flavour: a `store` foreign key and UUIDv7 primary keys. */
export const StoreModel = tenantModel({ field: 'store', to: () => Store, uuidPk: true })

export class Collection extends StoreModel({ title: new CharField({ maxLength: 100 }) }) {
  static Meta = { appLabel: 'shop' }
  declare products: RelatedManager<Product>
}

export class Tag extends StoreModel({ name: new CharField({ maxLength: 50 }) }) {
  static Meta = { appLabel: 'shop' }
}

export class Product extends StoreModel({
  title: new CharField({ maxLength: 100 }),
  handle: new SlugField(),
  collection: new ForeignKey(() => Collection, { onDelete: SET_NULL, null: true, relatedName: 'products' }),
  tags: new ManyToManyField(() => Tag, { relatedName: 'products' }),
}) {
  static Meta = { appLabel: 'shop', uniqueTogether: [['store', 'handle']] }
}

/** Integer primary keys (no default): exercises the "explicit key on a new object" check. */
export class Note extends tenantModel({ field: 'store', to: () => Store })({
  body: new CharField({ maxLength: 100 }),
}) {
  static Meta = { appLabel: 'shop' }
}

/** The default factory: a `tenant` foreign key to TENANTS.MODEL. */
export class Memo extends TenantModel({ text: new CharField({ maxLength: 100 }) }) {
  static Meta = { appLabel: 'shop' }
}

export const allModels = [Store, Collection, Tag, Product, Note, Memo]
