import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { JolliCredentialTable } from "@opencode-ai/core/jolli/sql"
import { JolliStore } from "@opencode-ai/core/jolli/store"

const run = <A>(effect: Effect.Effect<A, never, JolliStore.Service | Database.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([JolliStore.node, Database.node]), [
          [Database.node, Database.layerFromPath(":memory:")],
        ]),
      ),
      Effect.scoped,
    ),
  )

describe("JolliStore", () => {
  test("answers signed out until something is persisted", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const store = yield* JolliStore.Service
          return yield* store.active()
        }),
      ),
    ).toBeUndefined()
  })

  test("persists a sign-in and makes it active", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        yield* store.persist({
          subject: "usr_1",
          email: "student@acme.edu",
          baseUrl: "https://acme.jolli.ai",
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiry: 1_000,
        })
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({
      id: "usr_1",
      subject: "usr_1",
      email: "student@acme.edu",
      base_url: "https://acme.jolli.ai",
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_expiry: 1_000,
    })
    expect(row?.cache_key).toBeTruthy()
  })

  test("falls back to a fixed id when the backend reports no subject", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        yield* store.persist({ accessToken: "legacy-token" })
        return yield* store.active()
      }),
    )

    // A backend that predates the triple: access only, nothing to refresh with, no known expiry.
    expect(row).toMatchObject({ id: "default", refresh_token: null, token_expiry: null })
  })

  test("keeps the cache key across a re-sign-in", async () => {
    // This is the whole point of minting it only on insert: a new key would orphan the previous
    // catalogue snapshot on disk every time a student signed in again.
    const [first, second] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const before = yield* store.persist({ subject: "usr_1", accessToken: "access-1" })
        const after = yield* store.persist({ subject: "usr_1", accessToken: "access-2" })
        return [before.cache_key, after.cache_key]
      }),
    )

    expect(second).toBe(first)
  })

  test("gives the subjectless row a fresh cache key on every sign-in", async () => {
    /**
     * ⚠ THE OPPOSITE OF THE TEST ABOVE, AND DELIBERATELY. `sub` is optional on the wire, so every
     * sign-in that arrives without one lands on this single `default` row — two different students
     * on a lab machine included. Keeping the key there is keeping a cache filename, and
     * `jolli/cache.ts` keys the catalogue snapshot on exactly that: B would be served A's courses
     * and A's model grants. Without a subject nothing can tell a re-sign-in from a new person, so
     * this pays for a cold reload rather than risk the leak.
     */
    const [first, second] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const before = yield* store.persist({ accessToken: "student-a" })
        const after = yield* store.persist({ accessToken: "student-b" })
        return [before.cache_key, after.cache_key]
      }),
    )

    expect(second).not.toBe(first)
  })

  test("gives a different student a different cache key", async () => {
    const [a, b] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const first = yield* store.persist({ subject: "usr_1", accessToken: "a" })
        const second = yield* store.persist({ subject: "usr_2", accessToken: "b" })
        return [first.cache_key, second.cache_key]
      }),
    )

    expect(b).not.toBe(a)
  })

  test("a new student's sign-in takes the previous student's tokens with it", async () => {
    /**
     * ⚠ MOVING THE ACTIVE POINTER IS NOT SIGNING ANYBODY OUT. Rows are keyed by subject, so "use a
     * different account" used to leave the last student's access AND refresh token in a database
     * the next person on this machine shares — readable forever, because `remove` only ever
     * touches the active row. There is no account switcher holding them for later: the interface
     * exposes exactly one active credential.
     */
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        yield* store.persist({ subject: "usr_1", accessToken: "a", refreshToken: "refresh-a" })
        yield* store.persist({ subject: "usr_2", accessToken: "b", refreshToken: "refresh-b" })
        const { db } = yield* Database.Service
        return yield* Effect.orDie(db.select().from(JolliCredentialTable).all())
      }),
    )

    expect(rows.map((row) => row.id)).toEqual(["usr_2"])
  })

  test("forgets the tenant when a later sign-in does not report one", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        yield* store.persist({ subject: "usr_1", baseUrl: "https://acme.jolli.ai", accessToken: "a" })
        yield* store.persist({ subject: "usr_1", accessToken: "b" })
        return yield* store.active()
      }),
    )

    expect(row?.base_url).toBeNull()
  })

  test("a rotation replaces the triple and leaves the rest alone", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const stored = yield* store.persist({
          subject: "usr_1",
          baseUrl: "https://acme.jolli.ai",
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiry: 1_000,
        })
        yield* store.persistToken({
          id: stored.id,
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiry: 2_000,
        })
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-2",
      token_expiry: 2_000,
      base_url: "https://acme.jolli.ai",
    })
  })

  test("a rotation that names an address moves the row to it", async () => {
    // The tenant can move. A refresh is the only thing that ever hears about it, so a rotation
    // carrying an address has to win — while one that carries none leaves the row alone, which the
    // case above already pins.
    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const stored = yield* store.persist({
          subject: "usr_1",
          baseUrl: "https://acme.jolli.ai",
          accessToken: "access-1",
        })
        yield* store.persistToken({ id: stored.id, accessToken: "access-2", baseUrl: "https://acme.jolli.dev" })
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({ base_url: "https://acme.jolli.dev" })
  })

  test("a rotation never re-mints the cache key", async () => {
    const [before, after] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const stored = yield* store.persist({ subject: "usr_1", accessToken: "access-1" })
        yield* store.persistToken({ id: stored.id, accessToken: "access-2" })
        const row = yield* store.active()
        return [stored.cache_key, row?.cache_key]
      }),
    )

    expect(after).toBe(before)
  })

  test("removing clears the active pointer as well as the row", async () => {
    expect(
      await run(
        Effect.gen(function* () {
          const store = yield* JolliStore.Service
          const stored = yield* store.persist({ subject: "usr_1", accessToken: "a" })
          yield* store.remove(stored.id)
          return yield* store.active()
        }),
      ),
    ).toBeUndefined()
  })
})
