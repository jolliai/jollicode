import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { JolliStore } from "@opencode-ai/core/jolli/store"

/**
 * ⚠ SIGN-OUT DRIVES THE REAL CATALOGUE CACHE DIRECTORY, as `jolli-cache.test.ts` and
 * `credential.test.ts` already do: `Global.Path.cache` resolves when the module is imported and
 * cannot be redirected from a test. What it removes is a re-fetchable snapshot, never a credential.
 */
const TENANT = "https://acme.jolli.ai"
const MINUTE = 60_000

const originalFetch = globalThis.fetch
const originalToken = process.env["JOLLICODE_JOLLI_TOKEN"]
const originalBaseUrl = process.env["JOLLICODE_JOLLI_BASE_URL"]
afterEach(() => {
  globalThis.fetch = originalFetch
  restore("JOLLICODE_JOLLI_TOKEN", originalToken)
  restore("JOLLICODE_JOLLI_BASE_URL", originalBaseUrl)
})

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const services = LayerNode.group([JolliSession.node, JolliStore.node])

const run = <A, E>(effect: Effect.Effect<A, E, JolliSession.Service | JolliStore.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(AppNodeBuilder.build(services, [[Database.node, Database.layerFromPath(":memory:")]])),
      Effect.scoped,
    ),
  )

/** Counts how many times the refresh endpoint was actually called. */
function stubRefresh(handler: (request: Request) => Promise<Response>) {
  const seen: Request[] = []
  // Asserted because `typeof fetch` carries `preconnect`, which a stub has no business having.
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.url : input.toString(), init)
    seen.push(request)
    return handler(request)
  }) as typeof fetch
  return seen
}

const signedIn = (store: JolliStore.Interface, expiry: number | undefined, refreshToken = "refresh-1") =>
  store.persist({
    subject: "usr_1",
    baseUrl: TENANT,
    accessToken: "access-1",
    refreshToken,
    ...(expiry !== undefined ? { expiry } : {}),
  })

describe("JolliSession", () => {
  test("reports signed out when nothing is stored", async () => {
    const error = await run(
      Effect.gen(function* () {
        const session = yield* JolliSession.Service
        return yield* Effect.flip(session.token())
      }),
    )

    expect(error._tag).toBe("Jolli.SignedOut")
  })

  test("hands back the stored token without a network call when it is not near expiry", async () => {
    const seen = stubRefresh(async () => Response.json({}))

    const token = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 30 * MINUTE)
        return yield* session.token()
      }),
    )

    expect(token).toBe("access-1")
    expect(seen).toHaveLength(0)
  })

  test("never refreshes a legacy credential that carries no expiry", async () => {
    // A null expiry means a long-lived token with nothing to renew it with — fresh, not unknown.
    const seen = stubRefresh(async () => Response.json({}))

    const token = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* store.persist({ accessToken: "legacy-token" })
        return yield* session.token()
      }),
    )

    expect(token).toBe("legacy-token")
    expect(seen).toHaveLength(0)
  })

  test("a refresh that states no lifetime stays refreshable", async () => {
    /**
     * ⚠ THE ONE WAY A ROW CAN LEAVE THE REFRESH PATH FOR GOOD. `expires_in` is optional on the
     * wire, and a null expiry reads as fresh forever — so a single response that omits it would
     * retire the refresh token and answer 401 from the moment the access token actually died.
     * Nothing reacts to a 401; expiry is the only thing that renews, which is what makes that
     * terminal. An unstated lifetime alongside a refresh token gets a guess, not forever.
     */
    stubRefresh(async () => Response.json({ access_token: "access-2", refresh_token: "refresh-2" }))

    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        yield* session.token()
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" })
    expect(row?.token_expiry).not.toBeNull()
  })

  test("signing in with a refresh token but no stated lifetime stays refreshable", async () => {
    const row = await run(
      Effect.gen(function* () {
        const session = yield* JolliSession.Service
        const store = yield* JolliStore.Service
        yield* session.signIn({ token: "access-1", refreshToken: "refresh-1", subject: "usr_1", baseUrl: TENANT })
        return yield* store.active()
      }),
    )

    expect(row?.token_expiry).not.toBeNull()
  })

  test("refreshes inside the eager window and persists the whole triple", async () => {
    const seen = stubRefresh(async () =>
      Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 28_800 }),
    )

    const [token, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        // One minute of life left: inside the five-minute eager window, so this must renew.
        yield* signedIn(store, Date.now() + MINUTE)
        const fresh = yield* session.token()
        return [fresh, yield* store.active()] as const
      }),
    )

    expect(token).toBe("access-2")
    // The auth hub, not the tenant the row names: a tenant on a custom domain falls outside the
    // origin allowlist, and refreshing against it would refuse exactly those tenants.
    expect(seen.at(0)?.url).toBe("https://auth.jolli.ai/api/auth/cli-refresh")
    expect(row).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" })
    expect(row?.token_expiry).toBeGreaterThan(Date.now() + 7 * 60 * MINUTE)
  })

  test("keeps the refresh token it already had when the backend does not rotate", async () => {
    stubRefresh(async () => Response.json({ access_token: "access-2", expires_in: 3600 }))

    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        yield* session.token()
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({ access_token: "access-2", refresh_token: "refresh-1" })
  })

  test("refreshes a custom-domain tenant against the hub rather than refusing it", async () => {
    // `isJolliOriginAllowed` admits only the four Jolli domains, and `refreshCliToken` re-checks it
    // on every call. Sending the refresh to a tenant's own domain would fail that check and report
    // "unavailable" — the session would not end, it would just stop renewing and die at expiry.
    const seen = stubRefresh(async () => Response.json({ access_token: "access-2", expires_in: 3600 }))

    const token = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* store.persist({
          subject: "usr_1",
          baseUrl: "https://courses.university.edu",
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiry: Date.now() + MINUTE,
        })
        return yield* session.token()
      }),
    )

    expect(token).toBe("access-2")
    expect(seen.at(0)?.url).toBe("https://auth.jolli.ai/api/auth/cli-refresh")
  })

  test("follows the tenant when a refresh reports a new address", async () => {
    stubRefresh(async () =>
      Response.json({ access_token: "access-2", expires_in: 3600, baseUrl: "https://acme.jolli.dev" }),
    )

    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        yield* session.token()
        return yield* store.active()
      }),
    )

    // The next refresh has to go to the address the backend just named, not the one sign-in did.
    expect(row).toMatchObject({ base_url: "https://acme.jolli.dev" })
  })

  test("keeps the tenant address when a refresh reports none", async () => {
    // The endpoint answers without an address whenever the tenant registry is unreachable. Clearing
    // the row on that would send every later refresh to the auth hub instead, permanently, over one
    // bad read — which is why this field is the one thing a rotation does NOT write unconditionally.
    stubRefresh(async () => Response.json({ access_token: "access-2", expires_in: 3600 }))

    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        yield* session.token()
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({ base_url: TENANT })
  })

  test("signs out and forgets the credential when the refresh is rejected", async () => {
    stubRefresh(async () => new Response("", { status: 400 }))

    const [error, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        const failure = yield* Effect.flip(session.token())
        return [failure, yield* store.active()] as const
      }),
    )

    expect(error._tag).toBe("Jolli.SignedOut")
    expect(row).toBeUndefined()
  })

  test("renews a refused token that is nowhere near expiry", async () => {
    /**
     * ⚠ THE WHOLE REASON `refused` EXISTS. This token has three days of life left, so every
     * expiry-driven path reads it as fresh and would hand it straight back — while the backend has
     * been refusing it since the password changed. Expiry cannot see a revocation; only a 401 can.
     */
    const seen = stubRefresh(async () => Response.json({ access_token: "access-2", expires_in: 3600 }))

    const [token, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 72 * 60 * MINUTE)
        const renewed = yield* session.refused("access-1")
        return [renewed, yield* store.active()] as const
      }),
    )

    expect(token).toBe("access-2")
    expect(seen.length).toBe(1)
    expect(row).toMatchObject({ access_token: "access-2" })
  })

  test("forgets the credential when a refused token cannot be renewed", async () => {
    // The revocation case end to end: the backend deleted the renewal row when the password
    // changed, so the refusal is final and the student has to sign in again. Reaching this within
    // one request is the point — the alternative is three days of silent failures.
    stubRefresh(async () => new Response("", { status: 400 }))

    const [error, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 72 * 60 * MINUTE)
        const failure = yield* Effect.flip(session.refused("access-1"))
        return [failure, yield* store.active()] as const
      }),
    )

    expect(error._tag).toBe("Jolli.SignedOut")
    expect(row).toBeUndefined()
  })

  test("spends one rotation however many requests were refused at once", async () => {
    // A student's turn fires several model calls, and the gateway refuses all of them. Each one
    // that rotated would retire the credential the one before it had just been handed.
    const seen = stubRefresh(async () => Response.json({ access_token: "access-2", expires_in: 3600 }))

    const tokens = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 72 * 60 * MINUTE)
        return yield* Effect.all([session.refused("access-1"), session.refused("access-1")], {
          concurrency: "unbounded",
        })
      }),
    )

    expect(tokens).toEqual(["access-2", "access-2"])
    expect(seen.length).toBe(1)
  })

  test("answers from the store when the refused token has already been replaced", async () => {
    // A request that was in flight during somebody else's renewal comes back 401 holding the old
    // token. Nothing is wrong with the session — it just needs the token that replaced it.
    const seen = stubRefresh(async () => Response.json({ access_token: "access-3", expires_in: 3600 }))

    const token = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 72 * 60 * MINUTE)
        return yield* session.refused("access-0")
      }),
    )

    expect(token).toBe("access-1")
    expect(seen.length).toBe(0)
  })

  test("refuses an injected credential without touching the stored one", async () => {
    // `JOLLICODE_JOLLI_TOKEN` is a developer's paste: nothing renews it and it is not ours to
    // delete. Reading the store here would be worse than pointless — with a real sign-in also
    // present, its token differs from the refused one and the caller would be handed somebody
    // else's credential.
    const seen = stubRefresh(async () => Response.json({ access_token: "access-2", expires_in: 3600 }))
    process.env["JOLLICODE_JOLLI_TOKEN"] = "injected-1"

    const [error, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 72 * 60 * MINUTE)
        const failure = yield* Effect.flip(session.refused("injected-1"))
        return [failure, yield* store.active()] as const
      }),
    )

    expect(error._tag).toBe("Jolli.SignedOut")
    expect(seen.length).toBe(0)
    expect(row).toMatchObject({ access_token: "access-1" })
  })

  test("keeps a refused credential when Jolli cannot be reached to renew it", async () => {
    // Same rule the eager window follows: an outage must not sign anybody out. The caller is handed
    // back the token it sent, which is how `plugin/jolli.ts` knows not to retry with it.
    stubRefresh(async () => new Response("", { status: 503 }))

    const [token, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 72 * 60 * MINUTE)
        const answer = yield* session.refused("access-1")
        return [answer, yield* store.active()] as const
      }),
    )

    expect(token).toBe("access-1")
    expect(row).toMatchObject({ access_token: "access-1" })
  })

  test("keeps the credential and the still-valid token when Jolli is unreachable", async () => {
    // The whole point of the eager window: a bad minute upstream must not end a student's session.
    stubRefresh(async () => new Response("", { status: 503 }))

    const [token, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        const fresh = yield* session.token()
        return [fresh, yield* store.active()] as const
      }),
    )

    expect(token).toBe("access-1")
    expect(row).toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" })
  })

  test("fails as unavailable once the token it is holding has actually expired", async () => {
    stubRefresh(async () => new Response("", { status: 503 }))

    const [error, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() - MINUTE)
        const failure = yield* Effect.flip(session.token())
        return [failure, yield* store.active()] as const
      }),
    )

    expect(error._tag).toBe("Jolli.Unavailable")
    // Unavailable is never destructive: the credential is still there to retry with.
    expect(row).toBeDefined()
  })

  test("signs out when an expired token has nothing to renew it with", async () => {
    const seen = stubRefresh(async () => Response.json({}))

    const [error, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* store.persist({ subject: "usr_1", accessToken: "access-1", expiry: Date.now() - MINUTE })
        const failure = yield* Effect.flip(session.token())
        return [failure, yield* store.active()] as const
      }),
    )

    expect(error._tag).toBe("Jolli.SignedOut")
    expect(row).toBeUndefined()
    // Nothing to send, so nothing was sent.
    expect(seen).toHaveLength(0)
  })

  test("coalesces concurrent refreshes into a single call", async () => {
    // A rotating refresh token cannot be replayed: the loser of a race holds a spent credential.
    const seen = stubRefresh(async () =>
      Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
    )

    const tokens = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + MINUTE)
        return yield* Effect.all([session.token(), session.token(), session.token(), session.token()], {
          concurrency: "unbounded",
        })
      }),
    )

    expect(tokens).toEqual(["access-2", "access-2", "access-2", "access-2"])
    expect(seen).toHaveLength(1)
  })

  test("signing in stores the triple with an absolute expiry", async () => {
    const before = Date.now()

    const row = await run(
      Effect.gen(function* () {
        const session = yield* JolliSession.Service
        const store = yield* JolliStore.Service
        yield* session.signIn({
          token: "access-1",
          refreshToken: "refresh-1",
          expiresIn: 28_800,
          subject: "usr_1",
          email: "student@acme.edu",
          baseUrl: TENANT,
        })
        return yield* store.active()
      }),
    )

    expect(row).toMatchObject({ id: "usr_1", access_token: "access-1", refresh_token: "refresh-1" })
    // Seconds on the wire become absolute milliseconds in the row.
    expect(row?.token_expiry).toBeGreaterThanOrEqual(before + 28_800_000)
  })

  test("an injected credential outranks the database", async () => {
    // The development affordance `jolli/DEV.md` documents. Nothing the product ships sets these.
    process.env["JOLLICODE_JOLLI_TOKEN"] = "injected"
    process.env["JOLLICODE_JOLLI_BASE_URL"] = TENANT
    const seen = stubRefresh(async () => Response.json({}))

    const [token, row] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        // Even a stored credential that is due for renewal loses to the injected one.
        yield* signedIn(store, Date.now() + MINUTE)
        return [yield* session.token(), yield* session.current()] as const
      }),
    )

    expect(token).toBe("injected")
    expect(row).toMatchObject({ id: "env", base_url: TENANT })
    // An injected token has no expiry and nothing to renew it with, so it never reaches refresh.
    expect(seen).toHaveLength(0)
  })

  test("signing out removes the stored credential and leaves the injected one alone", async () => {
    process.env["JOLLICODE_JOLLI_TOKEN"] = "injected"

    const [stored, current] = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 30 * MINUTE)
        yield* session.signOut()
        return [yield* store.active(), yield* session.current()] as const
      }),
    )

    expect(stored).toBeUndefined()
    expect(current).toMatchObject({ id: "env" })
  })

  test("signing out leaves neither the credential nor the catalogue it unlocked", async () => {
    /**
     * ⚠ REMOVING THE ROW IS NOT ENOUGH. The snapshot is a file of this student's course codes,
     * their instructors' assistant names and their model grants, in a directory the next account on
     * this machine can read. Keyed storage stops a stale one being served; only deleting it stops
     * one being found.
     */
    mkdirSync(Global.Path.cache, { recursive: true })
    const snapshot = path.join(Global.Path.cache, "jolli-catalog-signout-probe.json")
    writeFileSync(snapshot, "{}")

    const row = await run(
      Effect.gen(function* () {
        const store = yield* JolliStore.Service
        const session = yield* JolliSession.Service
        yield* signedIn(store, Date.now() + 30 * MINUTE)
        yield* session.signOut()
        return yield* store.active()
      }),
    )

    expect(row).toBeUndefined()
    expect(existsSync(snapshot)).toBe(false)
  })
})
