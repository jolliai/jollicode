import { JolliSignedOut, JolliUnavailable } from "../src/jolli/session"
import { JolliApiError } from "../src/jolli/api"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { Database } from "../src/database/database"
import {
  makeGroupChatCache,
  canReadOffline,
  offlineCredentialFailure,
  MAX_CACHE_AGE,
} from "../src/jolli/group-chat-cache"
import { groupChatID } from "../src/jolli/org-scoped-id"
import { listChats } from "../src/jolli/group-chat"
import { JolliGroupChatCacheTable } from "../src/jolli/sql"
const org = { tenantSlug: "school", orgSlug: "course" }
function chat(n: number, courseId = "7"): Jolli.GroupChat {
  return {
    id: groupChatID(org, `chat-${n}`),
    viewerId: 1,
    title: "Lab",
    courseId,
    access: "participant",
    processing: false,
    group: { participants: [], formerPeople: [], aliases: [] },
    messages: Array.from({ length: 510 }, (_, i) => ({
      kind: "message",
      id: i,
      seq: i,
      turnId: i,
      role: "user",
      content: "Hi",
      timestamp: "2026-11-10T00:00:00Z",
    })),
  }
}
function run(check: (cache: ReturnType<typeof makeGroupChatCache>, database: Database.Interface) => Promise<void>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* Effect.promise(() => check(makeGroupChatCache(database), database))
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}
test("offline reads accept only network failures and gateway outages", () => {
  expect([undefined, 502, 503, 504].every(canReadOffline)).toBe(true)
  expect([200, 400, 401, 403, 404, 409, 429, 500].some(canReadOffline)).toBe(false)
})
test("bounds messages and LRU, respects account isolation and expires after seven days", () =>
  run(async (cache) => {
    const now = Date.now()
    for (let i = 0; i < 51; i++) await cache.put("a", chat(i), 0, now + i)
    expect(await cache.get("a", chat(0).id, now + 100)).toBeUndefined()
    const entry = await cache.get("a", chat(50).id, now + 100)
    expect(entry?.chat.messages).toHaveLength(500)
    expect(entry?.truncated).toBe(true)
    expect(await cache.get("b", chat(50).id, now + 100)).toBeUndefined()
    expect(await cache.get("a", chat(50).id, now + MAX_CACHE_AGE + 100)).toBeUndefined()
  }))
test("membership invalidates offline reading until a fresh authorized read", () =>
  run(async (cache) => {
    const value = chat(1)
    await cache.put("a", value, 0)
    await cache.unconfirm("a", value.id)
    expect(await cache.get("a", value.id)).toBeUndefined()
    await cache.put("a", value, 0)
    expect(await cache.get("a", value.id)).toBeUndefined()
    await cache.put("a", value, cache.version("a", value.id))
    expect((await cache.get("a", value.id))?.chat.id).toBe(value.id)
    await cache.remove("a", value.id)
    expect(await cache.get("a", value.id)).toBeUndefined()
  }))
test("only a complete list may purge, and a course filter cannot purge another course", () =>
  run(async (cache) => {
    await cache.put("a", chat(1, "7"), 0)
    await cache.put("a", chat(2, "8"), 0)
    await cache.reconcile("a", [], false)
    expect(await cache.get("a", chat(1).id)).toBeDefined()
    await cache.reconcile("a", [], true, "7")
    expect(await cache.get("a", chat(1).id)).toBeUndefined()
    expect(await cache.get("a", chat(2).id)).toBeDefined()
  }))

test("only unavailable credentials may read a previously authorized cache", () => {
  expect(offlineCredentialFailure(new JolliUnavailable({ message: "Network unavailable" }))).toBe(true)
  expect(offlineCredentialFailure(new JolliSignedOut({ message: "Sign in again" }))).toBe(false)
  expect(offlineCredentialFailure(new JolliApiError({ path: "chat", status: 500, message: "Failed" }))).toBe(false)
})
test("offline navigation lists only confirmed, unexpired chats belonging to the account", () =>
  run(async (cache) => {
    await cache.put("a", chat(1), 0)
    await cache.put("a", chat(2), 0)
    await cache.unconfirm("a", chat(2).id)
    expect((await cache.list("a")).map((entry) => entry.chat.id)).toEqual([chat(1).id])
    expect(await cache.list("another-account")).toEqual([])
    expect(await cache.list("a", Date.now() + MAX_CACHE_AGE + 1000)).toEqual([])
  }))
test("a sign-out or another sign-in drops a read that was still on its way to the cache", () =>
  run(async (cache) => {
    const value = chat(1)
    const version = cache.version("a", value.id)
    cache.forget()
    await cache.put("a", value, version)
    expect(await cache.get("a", value.id)).toBeUndefined()
    await cache.put("a", value, cache.version("a", value.id))
    expect((await cache.get("a", value.id))?.chat.id).toBe(value.id)
  }))
test("an offline copy this version cannot read is deleted instead of failing the list", () =>
  run(async (cache, database) => {
    await cache.put("a", chat(1), 0)
    const now = Date.now()
    await Effect.runPromise(
      database.db
        .insert(JolliGroupChatCacheTable)
        .values({
          account_id: "a",
          chat_id: "school:course:broken",
          course_id: "7",
          payload: "{",
          validated_at: now,
          accessed_at: now,
          confirmed: true,
          truncated: false,
        })
        .run()
        .pipe(Effect.orDie),
    )
    expect((await cache.list("a")).map((entry) => entry.chat.id)).toEqual([chat(1).id])
    const rows = await Effect.runPromise(database.db.select().from(JolliGroupChatCacheTable).all().pipe(Effect.orDie))
    expect(rows.map((row) => row.chat_id)).toEqual([chat(1).id])
  }))
test("a list that could not read the catalogue purges no offline copy", () =>
  run(async (cache) => {
    await cache.put("a", chat(1, "7"), 0)
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/api/me/courses") return Response.json({ home: org, courses: [{ id: 7, org }] })
        if (path === "/api/auth/session-config") return Response.json({ groupChatsEnabled: true })
        return Response.json({ convos: [], unavailable: [] })
      },
    })
    const request = { origin: server.url.origin, token: "test-token", identity: "a" }
    const answer = await Effect.runPromise(listChats(request, undefined, "7")).finally(() => server.stop(true))
    await cache.reconcile("a", [], answer.complete, "7")
    expect(answer.complete).toBe(false)
    expect(await cache.get("a", chat(1).id)).toBeDefined()
  }))
