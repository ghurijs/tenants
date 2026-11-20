// A tenant-scoped conversation model for @ghuri/agents (AGENTS.CONVERSATION_MODEL): a user who belongs to two
// stores only sees the current store's conversations; the other store's are 404.
import {
  Agent,
  AgentRouter,
  AgentsConfig,
  conversationFields,
  getConversationModel,
  Message,
  Run,
} from '@ghuri/agents'
import { AuthConfig, ContentTypesConfig, PBKDF2PasswordHasher, User } from '@ghuri/auth'
import { AppConfig, apps, createApp, defineSettings, include, path } from '@ghuri/core'
import { connections, type Manager } from '@ghuri/orm'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { APIClient } from '@ghuri/rest/testing'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { HeaderResolver, runAsTenant, TenantMiddleware, withoutTenant } from '../src'
import { backends } from './helpers'
import { Store, StoreModel } from './models'

/** The project's conversation model: the agents fields plus a `store` foreign key, scoped to the current store. */
class Conversation extends StoreModel({ ...conversationFields }) {
  declare static objects: Manager<Conversation>
  static Meta = { appLabel: 'shop', ordering: ['-updatedAt'] }
}

class ShopConfig extends AppConfig {
  name = 'shop'
  override models = { Store, Conversation }
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

class SupportAgent extends Agent {
  override model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Hello!' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }),
  })
}

const router = new AgentRouter()
router.register('support', SupportAgent)

describe.each(backends)('tenant-scoped agent conversations (%s)', (using) => {
  let db: TestDatabase
  let api: APIClient
  let a: Store
  let b: Store
  let alice: any

  beforeAll(async () => {
    const settings = defineSettings(() => ({
      SECRET_KEY: 'test-secret',
      INSTALLED_APPS: [ContentTypesConfig, AuthConfig, ShopConfig, AgentsConfig],
      MIDDLEWARE: [TenantMiddleware],
      ROOT_URLCONF: [path('agents/', include(router.urls))],
      PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })],
      TENANTS: { MODEL: Store, RESOLVERS: [new HeaderResolver({ header: 'X-Store', field: 'slug' })] },
      AGENTS: { CONVERSATION_MODEL: 'shop.Conversation', TRACE_RUNS: true },
    }))
    const app = createApp(settings as any, { checks: false })
    const env = {}
    await app.setup(env)
    db = await setupTestDatabase({ using })
    api = new APIClient(app, { env, defaultFormat: 'json' })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
    apps.reset()
  })
  beforeEach(async () => {
    await db.flush()
    ;[a, b] = await withoutTenant(async () => [
      await Store.objects.create({ name: 'A', slug: 'a' }),
      await Store.objects.create({ name: 'B', slug: 'b' }),
    ])
    alice = await User.objects.createUser('alice', 'alice@example.com', 'pw')
    api.forceAuthenticate(alice)
  })

  async function chat(store: string, conversationId?: string) {
    return api.post(
      '/agents/support/chat',
      { message: 'hi', ...(conversationId ? { conversationId } : {}) },
      {
        headers: { 'X-Store': store },
      },
    )
  }

  it('swaps agents.Conversation for the store model (no agents_conversation table)', async () => {
    expect(getConversationModel()).toBe(Conversation)
    expect(apps.getModels().map((m: any) => m._meta.label)).not.toContain('agents.Conversation')
    expect(Message._meta.getForwardField('conversation')!.relatedModel).toBe(Conversation)
    const conn = await connections.get()
    const sql =
      conn.dialect === 'postgresql'
        ? "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'"
        : "SELECT name FROM sqlite_master WHERE type = 'table'"
    const tables = (await conn.execute(sql)).rows.map((r: any) => r.name)
    expect(tables).toContain('shop_conversation')
    expect(tables).toContain('agents_message')
    expect(tables).not.toContain('agents_conversation')
  })

  it("keeps each store's conversations to itself: the other store's are 404", async () => {
    const inA = await chat('a')
    expect(inA.status).toBe(200)
    const inB = await chat('b')
    expect(inB.status).toBe(200)
    const idA = inA.data.conversationId as string
    const idB = inB.data.conversationId as string

    const stores = await withoutTenant(async () =>
      Object.fromEntries(
        (await (Conversation as any).unscoped.all()).map((c: any) => [String(c.pk), String(c.storeId)]),
      ),
    )
    expect(stores).toEqual({ [idA]: String(a.pk), [idB]: String(b.pk) })

    const listA = await api.get('/agents/support/conversations/', undefined, { headers: { 'X-Store': 'a' } })
    expect(listA.data.results.map((c: any) => c.id)).toEqual([idA])
    const listB = await api.get('/agents/support/conversations/', undefined, { headers: { 'X-Store': 'b' } })
    expect(listB.data.results.map((c: any) => c.id)).toEqual([idB])

    const own = await api.get(`/agents/support/conversations/${idB}/`, undefined, {
      headers: { 'X-Store': 'b' },
    })
    expect(own.status).toBe(200)
    expect(own.data.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])

    const other = await api.get(`/agents/support/conversations/${idB}/`, undefined, {
      headers: { 'X-Store': 'a' },
    })
    expect(other.status).toBe(404)
    expect((await chat('a', idB)).status).toBe(404)
    const del = await api.delete(`/agents/support/conversations/${idB}/`, undefined, {
      headers: { 'X-Store': 'a' },
    })
    expect(del.status).toBe(404)
    expect(await runAsTenant(b, () => Conversation.objects.count())).toBe(1)

    // continuing in the right store appends to the conversation
    expect((await chat('b', idB)).status).toBe(200)
    expect(await Message.objects.filter({ conversation: idB }).count()).toBe(4)
    // run traces point at the store conversation too
    expect(Run._meta.getForwardField('conversation')!.relatedModel).toBe(Conversation)
    expect(await Run.objects.filter({ conversation: idB, status: 'ok' }).count()).toBe(2)
  })
})
