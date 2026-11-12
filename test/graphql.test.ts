// @ghuri/graphql reads through `_defaultManager.getQueryset()`, so tenant scoping reaches root lists, relations,
// connections and Relay `node(id:)` lookups without any per-type code.
import { ConnectionField, ModelType, Node, Query, Schema, toGlobalId } from '@ghuri/graphql'
import { describe, expect, it } from 'vitest'
import { runAsTenant } from '../src'
import { backends, seed, useDatabase } from './helpers'
import { Collection, Product } from './models'

class ProductNode extends ModelType {
  static override Meta = {
    model: Product,
    fields: ['id', 'title', 'handle', 'collection'],
    interfaces: [Node],
  }
}
class CollectionNode extends ModelType {
  static override Meta = { model: Collection, fields: ['id', 'title', 'products'], interfaces: [Node] }
}
class ShopQuery extends Query {
  static override fields = {
    node: Node.Field(),
    products: ConnectionField(ProductNode),
    collections: ConnectionField(CollectionNode),
  }
}
const schema = new Schema({ query: ShopQuery })

const titles = (conn: any) => conn.edges.map((e: any) => e.node.title).sort()

describe.each(backends)('GraphQL through tenant-scoped models (%s)', (using) => {
  useDatabase(using)

  it('scopes root connections and nested relations', async () => {
    const w = await seed()
    const q =
      '{ products { edges { node { title } } } collections { edges { node { title products { edges { node { title } } } } } } }'
    const a = await runAsTenant(w.a, () => schema.execute(q))
    expect(a.errors).toBeUndefined()
    expect(titles((a.data as any).products)).toEqual(['Cap', 'Shirt'])
    expect(titles((a.data as any).collections)).toEqual(['Summer A'])
    const b = await runAsTenant(w.b, () => schema.execute(q))
    expect(titles((b.data as any).products)).toEqual(['Shirt'])
    expect(titles((b.data as any).collections)).toEqual(['Summer B'])
  })

  it("returns null for another tenant's node(id:)", async () => {
    const w = await seed()
    const q = (id: string) => `{ node(id: "${id}") { ... on ProductNode { title } } }`
    const own = await runAsTenant(w.a, () => schema.execute(q(toGlobalId('ProductNode', w.pA.pk))))
    expect((own.data as any).node).toEqual({ title: 'Shirt' })
    const other = await runAsTenant(w.a, () => schema.execute(q(toGlobalId('ProductNode', w.pB.pk))))
    expect((other.data as any).node).toBeNull()
  })

  it('fails closed with no tenant', async () => {
    await seed()
    const r = await schema.execute('{ products { edges { node { title } } } }')
    expect(r.errors?.[0]?.message).toMatch(/needs a current tenant/)
  })
})
