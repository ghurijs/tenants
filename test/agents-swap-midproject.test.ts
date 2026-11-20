// Swapping AGENTS.CONVERSATION_MODEL in a project that already has conversations: the store-scoped model adopts
// the existing `agents_conversation` table (the recipe in the agents and multi-tenancy docs).
import { AgentsConfig, conversationFields, getConversationModel, Message, Run } from '@ghuri/agents'
import { AuthConfig, ContentTypesConfig, User } from '@ghuri/auth'
import { AppConfig, apps, bufferIO, createContext, setGlobalContext } from '@ghuri/core'
import { connections, type Manager, modelRegistry } from '@ghuri/orm'
import {
  type FieldSpec,
  Migration,
  ModelState,
  makeMigrations,
  migrate,
  operations as ops,
  showMigrations,
} from '@ghuri/orm/migrations'
import { setupTestDatabase } from '@ghuri/orm/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { runAsTenant, withoutTenant } from '../src'
import { backends } from './helpers'
import { Store, StoreModel } from './models'

/** The project's model: the agents fields and a store, keeping the table it takes over. */
class Conversation extends StoreModel({ ...conversationFields }) {
  declare static objects: Manager<Conversation>
  static Meta = { dbTable: 'agents_conversation', ordering: ['-updatedAt'] }
}

/** The field specs makemigrations would write for `model`. */
function fieldsOf(model: any): Record<string, FieldSpec> {
  return Object.fromEntries(ModelState.fromModel(model).fields) as Record<string, FieldSpec>
}

const shopMigrations = {
  get migrations() {
    const initial = new Migration({
      initial: true,
      operations: [ops.CreateModel({ name: 'Store', fields: fieldsOf(Store) })],
    })
    if (!withConversation) return { '0001_initial': initial }
    // What `makemigrations shop` writes for Conversation, then edited as the docs say: `managed: false` plus an
    // `AlterModelOptions` (state only), and a RunCode that adopts agents_conversation or creates it.
    return {
      '0001_initial': initial,
      '0002_conversation': new Migration({
        dependencies: [['shop', '0001_initial']],
        operations: [
          ops.CreateModel({
            name: 'Conversation',
            fields: fieldsOf(Conversation),
            options: { dbTable: 'agents_conversation', ordering: ['-updatedAt'], managed: false },
          }),
          ops.AlterModelOptions({ name: 'Conversation', options: { ordering: ['-updatedAt'] } }),
          ops.RunCode(async (state, _conn, { editor, using }) => {
            const Conv = state.getModel('shop', 'Conversation')
            if (!(await editor.tableNames()).includes('agents_conversation')) {
              await editor.createModel(Conv) // a new database: agents did not create it
              return
            }
            // existing conversations go to the first store (pick yours, e.g. from the user's membership)
            const first = await state.getModel('shop', 'Store').objects.using(using).orderBy('id').first()
            await editor.addField(Conv, Conv._meta.getField('store') as any, { default: first?.pk })
          }, ops.RunCode.noop),
        ],
      }),
    }
  },
}

let withConversation = false

class ShopConfig extends AppConfig {
  name = 'shop'
  override models = { Store }
  override migrations = shopMigrations
}

class SwappedShopConfig extends ShopConfig {
  override models = { Store, Conversation } as any
}

const settings: Record<string, any> = { SECRET_KEY: 'test', INSTALLED_APPS: [], AGENTS: {} }
setGlobalContext(createContext({ env: {}, settings: settings as any }))
afterAll(() => {
  apps.reset()
  setGlobalContext(undefined)
})

/** Test-only: forget relations resolved before a settings change (a real project restarts instead). */
function forgetConversationTargets() {
  for (const M of [Message, Run] as any[]) {
    const f = M._meta.getForwardField('conversation')
    const old = f.resolvedTarget
    const rels = old?._meta._relatedObjects
    if (rels?.includes(f.remoteField)) rels.splice(rels.indexOf(f.remoteField), 1)
    f.resolvedTarget = undefined
    f.remoteField = undefined
    modelRegistry.pending.add(f)
  }
}

/** Install the apps before (`false`) or after (`true`) the swap. */
async function install(swapped: boolean) {
  withConversation = swapped
  settings.AGENTS = swapped ? { CONVERSATION_MODEL: 'shop.Conversation' } : {}
  forgetConversationTargets()
  apps.reset()
  await apps.populate([
    ContentTypesConfig,
    AuthConfig,
    swapped ? SwappedShopConfig : ShopConfig,
    AgentsConfig,
  ])
}

describe.each(backends)('swapping the conversation model mid-project (%s)', (using) => {
  it('keeps existing conversations and messages, now scoped to a store', async () => {
    await install(false)
    const db = await setupTestDatabase({ using, models: [], createTables: false })
    try {
      // before: agents.Conversation
      await migrate({ io: bufferIO() })
      const [a, b] = await withoutTenant(async () => [
        await Store.objects.create({ name: 'A', slug: 'a' }),
        await Store.objects.create({ name: 'B', slug: 'b' }),
      ])
      const alice = await User.objects.createUser('alice', 'alice@example.com', 'pw')
      const Old = getConversationModel()
      const old = await Old.objects.create({ agent: 'support', user: alice, title: 'Old' } as any)
      await Message.objects.create({ conversation: old, role: 'user', content: 'hi' } as any)

      // swap: settings + the model + shop.0002_conversation
      await install(true)
      expect(getConversationModel()).toBe(Conversation)
      const io = bufferIO()
      await migrate({ io })
      expect(io.out.join('\n')).toContain('Applying shop.0002_conversation...')
      const status = await showMigrations({ connection: await connections.get() })
      expect(status.every((s) => s.applied)).toBe(true)
      expect((await makeMigrations({ io: bufferIO(), check: true })).migrations).toEqual([])

      const kept = await runAsTenant(a, () => Conversation.objects.get({ id: String(old.pk) }))
      expect(kept.title).toBe('Old')
      expect(await runAsTenant(b, () => Conversation.objects.count())).toBe(0)
      expect(await Message.objects.filter({ conversation: String(old.pk) }).count()).toBe(1)
      // new conversations get the current store and their messages satisfy the foreign key
      const fresh = await runAsTenant(b, () =>
        Conversation.objects.create({ agent: 'support', user: alice } as any),
      )
      expect(String((fresh as any).storeId)).toBe(String(b.pk))
      await Message.objects.create({ conversation: fresh, role: 'user', content: 'hey' } as any)
      expect(await Message.objects.count()).toBe(2)
    } finally {
      await db.teardown()
    }
  })

  it('the same migrations build a new database (tests, new environments)', async () => {
    await install(true)
    const db = await setupTestDatabase({ using, models: [], createTables: false })
    try {
      const io = bufferIO()
      await migrate({ io })
      const out = io.out.join('\n')
      expect(out.indexOf('shop.0002_conversation')).toBeLessThan(out.indexOf('agents.0001_initial'))
      const [a] = await withoutTenant(async () => [await Store.objects.create({ name: 'A', slug: 'a' })])
      const conv = await runAsTenant(a, () => Conversation.objects.create({ agent: 'support' } as any))
      await Message.objects.create({ conversation: conv, role: 'user', content: 'hi' } as any)
      await Run.objects.create({ agent: 'support', conversation: conv, status: 'ok' } as any)
      expect(await Run.objects.filter({ conversation: String(conv.pk) }).count()).toBe(1)
    } finally {
      await db.teardown()
    }
  })
})
