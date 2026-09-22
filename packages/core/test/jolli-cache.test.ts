import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Global } from "../src/global"
import { CATALOG_SCHEMA, catalogCachePath, clearCatalogCache, loadCatalog, refreshCatalog } from "../src/jolli/cache"

/**
 * ⚠ THESE DRIVE THE REAL CACHE FILE. `Global.Path.cache` is resolved when the module is imported,
 * so it cannot be redirected from a test — and the point of this module is the file, not the
 * fetching. Every tenant below exists only here, so its cache key collides with nothing.
 */
const written: string[] = []
/**
 * One file per tenant AND credential, so two students never share one.
 *
 * ⚠ THE REAL FUNCTION RATHER THAN A MIRROR OF IT. A test that recomputed the key would keep
 * passing while agreeing with nothing — it would assert against the file IT chose, not the one the
 * product writes.
 */
/**
 * ⚠ `identity` IS WHAT FILES A SNAPSHOT; `token` IS ONLY WHAT AUTHENTICATES A FETCH. The two used to
 * be the same value, which meant every token rotation orphaned the file — see `catalogCachePath`.
 */
const req = (origin: string, over: { identity?: string; token?: string; slug?: string } = {}) => ({
  origin,
  token: over.token ?? "jwt",
  identity: over.identity ?? "student-a",
  ...(over.slug ? { tenantSlug: over.slug } : {}),
})

const cacheFile = (origin: string, identity = "student-a", slug = "") =>
  catalogCachePath(req(origin, { identity, ...(slug ? { slug } : {}) }))

/**
 * ⚠ THE SCHEMA STAMP IS ADDED HERE, because a snapshot without one is deliberately unreadable —
 * that is what stops a file written by an older build flowing into the mapping layer as the wrong
 * shape. Tests that want to exercise THAT should write a snapshot with a different stamp.
 */
async function seed(origin: string, snapshot: unknown, ageMs = 0) {
  const file = cacheFile(origin)
  await mkdir(Global.Path.cache, { recursive: true })
  const stamped =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? { schema: CATALOG_SCHEMA, ...snapshot }
      : snapshot
  await writeFile(file, JSON.stringify(stamped))
  if (ageMs) {
    const when = new Date(Date.now() - ageMs)
    await utimes(file, when, when)
  }
  written.push(file)
  return file
}

afterEach(async () => {
  await Promise.all(written.splice(0).map((file) => rm(file, { force: true })))
})

function stub(handler: (url: string) => Response) {
  const seen: string[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      seen.push(new URL(request.url).pathname)
      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(request.url)))
    }),
  )
  return { seen, layer }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const course = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: "Systems Programming",
  description: null,
  code: "CS 310",
  status: "published",
  requiresCoding: true,
  endsOn: null,
  viewerRole: "course-student",
  isStaff: false,
  ...over,
})

const choice = (id: number) => ({
  id,
  name: "Pair programmer",
  blurb: "Works through the problem with you",
  icon: "Terminal",
  accent: 0,
  worksThroughProblems: true,
  answersFromMaterialsOnly: false,
  showCitations: true,
  modelId: "uuid-opus",
  allowedModelIds: ["uuid-opus"],
})

const providers = [
  {
    id: "p1",
    name: "anthropic",
    protocol: "anthropic",
    isActive: true,
    models: [{ id: "uuid-opus", name: "claude-opus-4-8", category: "Premium", description: null, isActive: true }],
  },
]

describe("refreshCatalog", () => {
  const origin = "https://cache-refresh.jolli.ai"

  /**
   * ⚠ THE HARD FILTER RUNS BEFORE THE ASSISTANT FAN-OUT, which is what stops an institution
   * administrator's whole-org course list turning into a request per course in the school.
   */
  test("stores only the viewer's own coding courses, and asks about no others", async () => {
    const http = stub((url) =>
      url.endsWith("/api/courses")
        ? json([
            course({ id: 7 }),
            course({ id: 8, requiresCoding: false }),
            course({ id: 9, viewerRole: "space-manager" }),
          ])
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    expect(snapshot.courses.map((c) => c.id)).toEqual([7])
    expect(Object.keys(snapshot.assistants)).toEqual(["7"])
    expect(http.seen.filter((p) => p.includes("assistant-choices"))).toEqual(["/api/courses/7/assistant-choices"])
    expect(snapshot.models.map((m) => m.id)).toEqual(["uuid-opus"])
  })

  /**
   * ⚠ ONE COURSE FAILING MUST NOT COST THE STUDENT THE REST. A course the viewer cannot read answers
   * 404 exactly as a deleted one does, and failing the batch would take every other course with it.
   */
  test("a course whose assistants cannot be listed keeps the rest of the catalogue", async () => {
    const http = stub((url) =>
      url.endsWith("/api/courses")
        ? json([course({ id: 7 }), course({ id: 8, code: "CS 101" })])
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : url.includes("/courses/8/")
            ? json({ message: "not found" }, 404)
            : json([choice(12)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    expect(snapshot.courses.map((c) => c.id)).toEqual([7, 8])
    expect(snapshot.assistants["7"]?.map((a) => a.id)).toEqual([12])
    expect(snapshot.assistants["8"]).toEqual([])
  })

  /**
   * ⚠ THE WRITE IS WHY THIS MODULE EXISTS: main fetches, the sidecar reads, and a second fetch
   * would be a second answer. A fresh file is served with no request at all.
   */
  test("writes a snapshot the next load serves without asking the gateway", async () => {
    const http = stub((url) =>
      url.endsWith("/api/courses") ? json([course()]) : url.endsWith("/api/agent/models") ? json(providers) : json([]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.stale).toBe(false)
    expect(loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 310"])
  })
})

/**
 * ⚠ THESE POINT AT A HOST THAT CANNOT RESOLVE, ON PURPOSE. `loadCatalog` brings its own HTTP client
 * (config loading has none to give it), so the only way to make the fetch fail is to have nowhere
 * for it to land — which is also exactly the student-on-a-train case the fallback exists for.
 */
describe("loadCatalog when the gateway cannot be reached", () => {
  const snapshot = { courses: [course()], assistants: { "7": [choice(12)] }, models: [] }

  /**
   * ⚠ "STALE" IS NOT "ABSENT". The TTL is five minutes so a professor's edits land quickly, which
   * means an offline student's cache is ALWAYS expired; refusing to serve it would make the product
   * unusable without a network.
   */
  test("serves an expired snapshot rather than failing, and says it is stale", async () => {
    const origin = "https://cache-stale.invalid"
    await seed(origin, snapshot, 10 * 60_000)
    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.stale).toBe(true)
    expect(loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 310"])
  }, 30_000)

  // A shape this build no longer understands is the same as no cache: refetch rather than guess.
  test("refuses to serve a snapshot it cannot recognise", async () => {
    const origin = "https://cache-broken.invalid"
    await seed(origin, { courses: [course()] })
    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind).toBe("unreachable")
  }, 30_000)

  /**
   * ⚠ ONE CACHE FILE PER CREDENTIAL, NOT PER TENANT. Two students share a machine here far more
   * often than in most products — a lab bench, a loaner laptop — and keyed by tenant alone the
   * second to sign in was served the first one's courses for the rest of the TTL.
   */
  test("does not serve one student's snapshot to the next", async () => {
    const origin = "https://cache-shared.invalid"
    await seed(origin, snapshot)
    // A different student, i.e. a different sign-in: a different identity, not merely a new token.
    const loaded = await Effect.runPromise(loadCatalog(req(origin, { identity: "student-b" })))
    expect(loaded.kind).toBe("unreachable")
  }, 30_000)

  /**
   * ⚠ THE REASON THE KEY IS NOT THE TOKEN. With an eight-hour access token and a rotation on every
   * renewal, keying on the token meant a student paid a cold three-request reload on the startup
   * path every few hours — and left the previous snapshot behind as an orphan each time.
   */
  test("a rotated token still reads the same student's snapshot", async () => {
    const origin = "https://cache-rotation.invalid"
    await seed(origin, snapshot)
    const loaded = await Effect.runPromise(loadCatalog(req(origin, { token: "rotated-access-token" })))
    expect(loaded.kind).toBe("ok")
  }, 30_000)

  test("the filename follows the identity and ignores the token", () => {
    const origin = "https://cache-key.invalid"
    expect(catalogCachePath(req(origin, { token: "one" }))).toBe(catalogCachePath(req(origin, { token: "two" })))
    expect(catalogCachePath(req(origin, { identity: "a" }))).not.toBe(catalogCachePath(req(origin, { identity: "b" })))
  })

  // Nothing cached and nobody to ask is the one case that must not read as "you have no courses".
  test("reports unreachable when there is nothing to fall back on", async () => {
    const loaded = await Effect.runPromise(loadCatalog(req("https://cache-empty.invalid")))
    expect(loaded.kind).toBe("unreachable")
  }, 30_000)
})

/**
 * ⚠ THE PER-REQUEST TIMEOUTS ARE NOT A BOUND ON `loadCatalog`, which is the whole reason the
 * deadline exists. A refresh makes three calls in sequence and waits on a cross-process lock before
 * any of them, so a caller holding up a sidecar fork needs one number it can rely on.
 */
describe("loadCatalog's refresh deadline", () => {
  const snapshot = { courses: [course()], assistants: { "7": [choice(12)] }, models: [] }

  test("falls back to the stale snapshot rather than waiting out the fetch", async () => {
    const origin = "https://cache-slow.invalid"
    await seed(origin, snapshot, 10 * 60_000)
    const started = Date.now()
    const loaded = await Effect.runPromise(loadCatalog(req(origin), { timeout: "250 millis" }))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(loaded.kind).toBe("ok")
    if (loaded.kind === "ok") expect(loaded.stale).toBe(true)
  }, 30_000)

  // Running out of time with nothing behind it is still "could not ask", never "you have no courses".
  test("reports unreachable when it times out with no snapshot", async () => {
    const loaded = await Effect.runPromise(
      loadCatalog(req("https://cache-slow-empty.invalid"), { timeout: "250 millis" }),
    )
    expect(loaded.kind).toBe("unreachable")
  }, 30_000)
})

/**
 * ⚠ KEYED STORAGE STOPS A SNAPSHOT BEING SERVED TO THE WRONG STUDENT; ONLY DELETING IT STOPS ONE
 * BEING FOUND. The button that reaches here is "use a different account" on a shared bench.
 */
describe("clearCatalogCache", () => {
  const snapshot = { courses: [course()], assistants: { "7": [choice(12)] }, models: [] }

  test("removes every cached catalogue and leaves other cache files alone", async () => {
    const mine = await seed("https://cache-signout.invalid", snapshot)
    const theirs = path.join(Global.Path.cache, "models.json")
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(theirs, "{}")

    await Effect.runPromise(clearCatalogCache())

    expect(await Bun.file(mine).exists()).toBe(false)
    expect(await Bun.file(theirs).exists()).toBe(true)
    await rm(theirs, { force: true })
  })

  test("is quiet when there is nothing cached", async () => {
    await expect(Effect.runPromise(clearCatalogCache())).resolves.toBeUndefined()
  })
})

/**
 * ⚠ EVERY TOKEN ROTATION ORPHANS A SNAPSHOT, and nothing else collects them: `clearCatalogCache`
 * runs on sign-out, which a student who simply keeps using the product never reaches. Each orphan
 * is their course codes and model grants left where the next account on the machine can read them.
 */
describe("refreshCatalog sweeps orphaned snapshots", () => {
  const origin = "https://cache-sweep.jolli.ai"
  const http = () =>
    stub((url) =>
      url.endsWith("/api/courses") ? json([course()]) : url.endsWith("/api/agent/models") ? json(providers) : json([]),
    )

  const refresh = async () => {
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http().layer)))
    written.push(cacheFile(origin))
  }

  /** An age past the retention window, which is a week. */
  const aged = async (name: string) => {
    const file = path.join(Global.Path.cache, name)
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(file, "{}")
    const when = new Date(Date.now() - 8 * 24 * 60 * 60_000)
    await utimes(file, when, when)
    written.push(file)
    return file
  }

  test("drops the snapshots of credentials nobody is refreshing any more", async () => {
    const orphan = await aged(`jolli-catalog-${"a".repeat(40)}.json`)
    await refresh()
    expect(await Bun.file(orphan).exists()).toBe(false)
  })

  /** A crashed write leaves one of these behind, and it carries the same prefix. */
  test("collects the temp files a crashed write left behind", async () => {
    const temp = await aged(`jolli-catalog-${"b".repeat(40)}.json.999.1.tmp`)
    await refresh()
    expect(await Bun.file(temp).exists()).toBe(false)
  })

  /**
   * ⚠ THE OTHER LIVE CREDENTIAL ON THIS MACHINE SURVIVES. The desktop keeps its token in the
   * keychain and a bare CLI keeps its own in `auth.json`; a sweep that kept only the caller's would
   * have the two deleting each other's snapshot on every refresh.
   */
  test("leaves a recent snapshot belonging to another credential alone", async () => {
    const other = await seed("https://cache-sweep-other.invalid", {
      courses: [course()],
      assistants: {},
      models: [],
    })
    await refresh()
    expect(await Bun.file(other).exists()).toBe(true)
  })

  test("leaves cache files that are not catalogues alone, however old", async () => {
    const theirs = path.join(Global.Path.cache, "models.json")
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(theirs, "{}")
    const when = new Date(Date.now() - 400 * 24 * 60 * 60_000)
    await utimes(theirs, when, when)

    await refresh()

    expect(await Bun.file(theirs).exists()).toBe(true)
    await rm(theirs, { force: true })
  })

  // The file this very refresh just wrote is the one thing the sweep must never touch.
  test("keeps the snapshot it has just written", async () => {
    await refresh()
    expect(await Bun.file(cacheFile(origin)).exists()).toBe(true)
  })
})
