import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Global } from "../src/global"
import { Flock } from "../src/util/flock"
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
  /** Each request's path with the org it was scoped to, if any. */
  const scoped: string[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      seen.push(new URL(request.url).pathname)
      scoped.push(`${new URL(request.url).pathname} ${request.headers["x-org-slug"] ?? "-"}`)
      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(request.url)))
    }),
  )
  return { seen, scoped, layer }
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

const org = (orgSlug: string) => ({
  tenantSlug: "acme",
  orgSlug,
  tenantId: "t1",
  orgId: orgSlug,
  institutionName: "Westfield",
  orgName: orgSlug,
})
const home = org("cs")

/** The cross-org list: each course tagged with an org (home unless it says otherwise). */
const listed = (courses: readonly Record<string, unknown>[], over: { unavailable?: readonly object[] } = {}) => ({
  courses: courses.map((item) => ({ org: home, ...item })),
  unavailable: over.unavailable ?? [],
  home,
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
      url.endsWith("/api/me/courses")
        ? json(
            listed([
              course({ id: 7 }),
              course({ id: 8, requiresCoding: false }),
              course({ id: 9, viewerRole: "space-manager" }),
            ]),
          )
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
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 8, code: "CS 101" })]))
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
   * ⚠ COURSE 7 IN ANOTHER ORG IS NOT COURSE 7 AT HOME. Its assistants are asked for in its own org,
   * and filed under an id that names the org, so the two never overwrite each other.
   */
  test("asks each course's assistants in its own org and files another org's under its scoped id", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 7, code: "BIO 7", org: org("bio") })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    expect(Object.keys(snapshot.assistants).toSorted()).toEqual(["7", "acme:bio:7"])
    expect(snapshot.home?.orgSlug).toBe("cs")
    expect(http.scoped.filter((line) => line.includes("assistant-choices")).toSorted()).toEqual([
      "/api/courses/7/assistant-choices -",
      "/api/courses/7/assistant-choices bio",
    ])
    // The lists and the models are deployment-wide reads, asked once and unscoped. With nothing on
    // disk to say which server this is, the home-only list is asked beside the cross-org one.
    expect(http.scoped.filter((line) => !line.includes("assistant-choices")).toSorted()).toEqual([
      "/api/agent/models -",
      "/api/courses -",
      "/api/me/courses -",
    ])
  })

  /**
   * ⚠ AN ORG THAT DID NOT ANSWER IS NOT AN ORG WITH NO COURSES. Its courses stay as the last answer
   * left them, so a session bound to one does not read as a course that is gone.
   */
  test("keeps the last answer's courses in an org that did not answer this time", async () => {
    const both = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 7, code: "BIO 7", org: org("bio") })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(both.layer)))
    written.push(cacheFile(origin))

    const homeOnly = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 })], { unavailable: [org("bio")] }))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(13)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(homeOnly.layer)))

    expect(snapshot.courses.map((c) => c.code)).toEqual(["CS 310", "BIO 7"])
    expect(snapshot.assistants["7"]?.map((a) => a.id)).toEqual([13])
    expect(snapshot.assistants["acme:bio:7"]?.map((a) => a.id)).toEqual([12])
    // Nothing was asked of the org that did not answer.
    expect(homeOnly.scoped.some((line) => line.endsWith(" bio"))).toBe(false)
    // And the snapshot says whose courses are old, so nothing serves it as fresh.
    expect(snapshot.unavailable?.map((o) => o.orgSlug)).toEqual(["bio"])
  })

  // An org late with part of its list: the course it did send is the newer copy, and the only one.
  test("carries nothing forward that this answer already has", async () => {
    const both = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7, code: "BIO 7", org: org("bio") }), course({ id: 8, org: org("bio") })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(both.layer)))
    written.push(cacheFile(origin))

    const partial = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7, code: "BIO 7 (new)", org: org("bio") })], { unavailable: [org("bio")] }))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(13)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(partial.layer)))
    expect(snapshot.courses.map((c) => c.code)).toEqual(["BIO 7 (new)", "CS 310"])
    expect(snapshot.assistants["acme:bio:7"]?.map((a) => a.id)).toEqual([13])
    expect(snapshot.assistants["acme:bio:8"]?.map((a) => a.id)).toEqual([12])
  })

  // The server listing a course it now hides is its newer word: the old visible copy must not return.
  test("carries nothing forward that this answer lists but no longer shows", async () => {
    const both = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7, code: "BIO 7", org: org("bio") })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(both.layer)))
    written.push(cacheFile(origin))

    const hidden = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(
            listed([course({ id: 7, code: "BIO 7", requiresCoding: false, org: org("bio") })], {
              unavailable: [org("bio")],
            }),
          )
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(13)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(hidden.layer)))
    expect(snapshot.courses).toEqual([])
    expect(snapshot.assistants["acme:bio:7"]).toBeUndefined()
  })

  /**
   * ⚠ AN ANSWER WITHOUT `home` MUST NOT RENAME EVERY HOME COURSE. Read without one, course 7 would
   * become "acme:cs:7" and every session bound to "7" would read as bound to a course that is gone —
   * so such a server is read through its home-only list, with the bare ids every build before used.
   */
  test("reads the home-only list from a server whose cross-org list names no home", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json({ ...listed([course({ id: 7 }), course({ id: 8, org: org("bio") })]), home: undefined })
        : url.endsWith("/api/courses")
          ? json([course({ id: 7 })])
          : url.endsWith("/api/agent/models")
            ? json(providers)
            : json([choice(12)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    expect(snapshot.home).toBeUndefined()
    expect(Object.keys(snapshot.assistants)).toEqual(["7"])
    // Asked unscoped, as every build before cross-org courses asked.
    expect(http.scoped.filter((line) => line.includes("assistant-choices"))).toEqual([
      "/api/courses/7/assistant-choices -",
    ])
  })

  /**
   * ⚠ A SERVER THAT LAST ANSWERED HOME-ONLY IS ASKED FOR BOTH LISTS AT ONCE. In turn, every refresh
   * would wait out the cross-org fan-out — up to five seconds for a slow org — before asking for the
   * list it actually reads.
   */
  test("asks a server that last answered home-only for both lists at once", async () => {
    const events: string[] = []
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/api/me/courses") {
          events.push("cross-org asked")
          await Bun.sleep(300)
          events.push("cross-org answered")
          return json({ ...listed([course({ id: 7 })]), home: undefined })
        }
        if (pathname === "/api/courses") {
          events.push("home-only asked")
          return json([course({ id: 7 })])
        }
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(12)])
      },
    })
    const origin = server.url.origin
    await seed(origin, { courses: [course({ id: 7 })], assistants: { "7": [choice(12)] }, models: [] })

    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(snapshot.home).toBeUndefined()
    expect(events.indexOf("home-only asked")).toBeLessThan(events.indexOf("cross-org answered"))
  })

  // With nothing on disk — a first launch, or the first after a schema bump — the server is unknown,
  // and that load sits under the startup deadline, so it is not asked in turn either.
  test("asks for both lists at once with nothing on disk", async () => {
    const events: string[] = []
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        if (pathname === "/api/me/courses") {
          events.push("cross-org asked")
          await Bun.sleep(300)
          events.push("cross-org answered")
          return json({ ...listed([course({ id: 7 })]), home: undefined })
        }
        if (pathname === "/api/courses") {
          events.push("home-only asked")
          return json([course({ id: 7 })])
        }
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(12)])
      },
    })
    const origin = server.url.origin
    written.push(cacheFile(origin))

    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(FetchHttpClient.layer)))
    expect(snapshot.courses.map((c) => c.id)).toEqual([7])
    expect(events.indexOf("home-only asked")).toBeLessThan(events.indexOf("cross-org answered"))
  })

  // A server without `home` has no use for the cross-org list: its failing must not cost the home-only one.
  test("reads the home-only list when the cross-org one asked beside it fails", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json({ message: "boom" }, 500)
        : url.endsWith("/api/courses")
          ? json([course({ id: 7 })])
          : url.endsWith("/api/agent/models")
            ? json(providers)
            : json([choice(12)]),
    )
    written.push(cacheFile(origin))
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    expect(snapshot.home).toBeUndefined()
    expect(snapshot.courses.map((c) => c.id)).toEqual([7])
  })

  test("fails with the cross-org list's error when neither list can be read", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json({ message: "boom" }, 500)
        : url.endsWith("/api/courses")
          ? json({ message: "down" }, 503)
          : json(providers),
    )
    written.push(cacheFile(origin))
    const failed = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer), Effect.flip))
    expect(failed.status).toBe(500)
  })

  /**
   * ⚠ A HOME-ONLY SNAPSHOT'S IDS ARE ALL BARE HOME IDS, which mean the same courses once the server
   * names home. Thrown away on that first refresh, a course whose assistants failed to list would be
   * left with none to start.
   */
  test("keeps a home-only snapshot's assistants on the refresh that first names home", async () => {
    await seed(origin, { courses: [course({ id: 7 })], assistants: { "7": [choice(12)] }, models: [] })
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : url.endsWith("/api/courses")
            ? json([course({ id: 7 })])
            : json({ message: "unavailable" }, 503),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    expect(snapshot.home?.orgSlug).toBe("cs")
    expect(snapshot.assistants["7"]?.map((a) => a.id)).toEqual([12])
    expect(snapshot.assistantsKept).toEqual(["7"])
  })

  // Once a snapshot names home, the server is known to answer the cross-org list: only that is asked.
  test("asks only for the cross-org list when the last snapshot named home", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    await seed(origin, { courses: [course({ id: 7 })], home, assistants: { "7": [choice(12)] }, models: [] })

    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    expect(http.seen).not.toContain("/api/courses")
  })

  // Asked alongside in case the server still predates `home`; once it names home, that list is not needed.
  test("does not fail a server that names home over the home-only list asked beside it", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 8, org: org("bio") })]))
        : url.endsWith("/api/courses")
          ? json({ message: "unavailable" }, 503)
          : url.endsWith("/api/agent/models")
            ? json(providers)
            : json([choice(12)]),
    )
    await seed(origin, { courses: [course({ id: 7 })], assistants: { "7": [choice(12)] }, models: [] })

    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    expect(http.seen).toContain("/api/courses")
    expect(snapshot.home?.orgSlug).toBe("cs")
    expect(Object.keys(snapshot.assistants).sort()).toEqual(["7", "acme:bio:8"])
  })

  test("reads the home-only list from a server without the cross-org one", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json({ message: "not found" }, 404)
        : url.endsWith("/api/courses")
          ? json([course({ id: 7 })])
          : url.endsWith("/api/agent/models")
            ? json(providers)
            : json([choice(12)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    expect(snapshot.courses.map((c) => c.id)).toEqual([7])
    expect(Object.keys(snapshot.assistants)).toEqual(["7"])
  })

  /**
   * ⚠ ONLY A 404 SAYS A COURSE HAS NO ASSISTANTS. A timeout or an org that is down keeps the last
   * list — emptied, a course in an org too slow to answer would offer no assistant to start.
   */
  test("keeps a course's last assistants when listing them fails for any reason but a 404", async () => {
    const first = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 8, code: "CS 101" })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(first.layer)))
    written.push(cacheFile(origin))

    const failing = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 8, code: "CS 101" })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : url.includes("/courses/8/")
            ? json({ message: "not found" }, 404)
            : json({ message: "unavailable" }, 503),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(failing.layer)))
    expect(snapshot.assistants["7"]?.map((a) => a.id)).toEqual([12])
    expect(snapshot.assistants["8"]).toEqual([])
    // The kept list is as old as the last answer, so the snapshot says so and is asked again sooner.
    expect(snapshot.assistantsKept).toEqual(["7"])
  })

  // Each incomplete answer in a row spaces the next retry further, so a course that keeps failing
  // does not cost a whole-catalogue load every minute.
  test("counts the incomplete answers in a row, and forgets them once one is complete", async () => {
    const answer = (assistants: () => Response) =>
      stub((url) =>
        url.endsWith("/api/me/courses")
          ? json(listed([course({ id: 7 })]))
          : url.endsWith("/api/agent/models")
            ? json(providers)
            : url.endsWith("/api/courses")
              ? json([course({ id: 7 })])
              : assistants(),
      )
    const failing = answer(() => json({ message: "unavailable" }, 503))
    const run = (http: ReturnType<typeof stub>) =>
      Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    expect((await run(failing)).incompleteRuns).toBe(1)
    expect((await run(failing)).incompleteRuns).toBe(2)
    expect((await run(failing)).incompleteRuns).toBe(3)
    const complete = await run(answer(() => json([choice(12)])))
    expect(complete.incompleteRuns).toBeUndefined()
    expect((await run(failing)).incompleteRuns).toBe(1)
  })

  /**
   * ⚠ A SERVER THAT STOPS NAMING HOME DROPS OTHER ORGS' COURSES, AND THAT IS DELIBERATE. Such a
   * server refuses every scoped request from a CLI token, so those courses could not be used; and the
   * snapshot's assistants are keyed under the old home, so none of them is carried into the new one.
   */
  test("reads a server that stopped naming home as home-only, carrying nothing from the old home", async () => {
    await seed(origin, {
      courses: [
        { ...course({ id: 7 }), org: home },
        { ...course({ id: 8 }), org: org("bio") },
      ],
      home,
      assistants: { "7": [choice(12)], "acme:bio:8": [choice(13)] },
      models: [],
      unavailable: [org("bio")],
    })
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json({ ...listed([course({ id: 7 }), course({ id: 8, org: org("bio") })]), home: undefined })
        : url.endsWith("/api/courses")
          ? json([course({ id: 7 })])
          : url.endsWith("/api/agent/models")
            ? json(providers)
            : json([choice(14)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))

    expect(snapshot.home).toBeUndefined()
    expect(snapshot.courses.map((c) => c.id)).toEqual([7])
    expect(snapshot.assistants).toEqual({ "7": [expect.objectContaining({ id: 14 })] })
  })

  // An org that answered with no course for this person has none: nothing is carried for it.
  test("drops an org's courses once it answers without them", async () => {
    const both = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 }), course({ id: 7, code: "BIO 7", org: org("bio") })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(both.layer)))
    written.push(cacheFile(origin))

    const homeOnly = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course({ id: 7 })]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([choice(12)]),
    )
    const snapshot = await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(homeOnly.layer)))
    expect(snapshot.courses.map((c) => c.code)).toEqual(["CS 310"])
    expect(Object.keys(snapshot.assistants)).toEqual(["7"])
  })

  /**
   * ⚠ THE WRITE IS WHY THIS MODULE EXISTS: main fetches, the sidecar reads, and a second fetch
   * would be a second answer. A fresh file is served with no request at all.
   */
  test("writes a snapshot the next load serves without asking the gateway", async () => {
    const http = stub((url) =>
      url.endsWith("/api/me/courses")
        ? json(listed([course()]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([]),
    )
    await Effect.runPromise(refreshCatalog(req(origin)).pipe(Effect.provide(http.layer)))
    written.push(cacheFile(origin))

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.error).toBeUndefined()
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
  test("serves an expired snapshot rather than failing, and says what the refresh failed with", async () => {
    const origin = "https://cache-stale.invalid"
    await seed(origin, snapshot, 10 * 60_000)
    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.error).toBeDefined()
    expect(loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 310"])
  }, 30_000)

  // A shape this build no longer understands is the same as no cache: refetch rather than guess.
  /**
   * ⚠ ONLY A SCHEMA 3 SNAPSHOT WITHOUT `home` CHANGED MEANING. One that names home is keyed exactly as
   * this build keys it; refused, every student's first launch after the upgrade would find nothing on
   * disk, and an offline one would get no courses at all.
   */
  test("still serves a schema 3 snapshot that names home, and refuses one that does not", async () => {
    const named = "https://cache-schema3-home.invalid"
    await seed(named, { schema: 3, courses: [course()], home, assistants: { "7": [choice(12)] }, models: [] })
    const loaded = await Effect.runPromise(loadCatalog(req(named)))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.id)).toEqual([7])

    const unnamed = "https://cache-schema3-nohome.invalid"
    await seed(unnamed, { schema: 3, courses: [course()], assistants: { "acme:cs:7": [choice(12)] }, models: [] })
    expect((await Effect.runPromise(loadCatalog(req(unnamed)))).kind).toBe("unreachable")
  }, 30_000)

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

/** Wait for what a refresh running behind its caller leaves on disk. */
async function settles(check: () => boolean | Promise<boolean>, within = 5_000) {
  const until = Date.now() + within
  while (!(await check())) {
    if (Date.now() > until) throw new Error("the background refresh never landed")
    await Bun.sleep(20)
  }
}

const codesOnDisk = async (origin: string) =>
  ((JSON.parse(await Bun.file(cacheFile(origin)).text()) as { courses: { code: string }[] }).courses ?? []).map(
    (c) => c.code,
  )

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
    if (loaded.kind === "ok") expect(loaded.error).toBeDefined()
  }, 30_000)

  /**
   * ⚠ THE DEADLINE STOPS THE CALLER WAITING, NOT THE REFRESH. Cut off with it, a refresh slower than
   * the guardrail check's five seconds would never be written, and every check would start it again.
   */
  test("leaves a refresh it stopped waiting for to finish and write", async () => {
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        await Bun.sleep(300)
        if (pathname === "/api/me/courses") return json(listed([course()]))
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(13)])
      },
    })
    const origin = server.url.origin
    await seed(origin, { ...snapshot, courses: [course({ code: "CS 101" })] }, 10 * 60_000)

    const loaded = await Effect.runPromise(loadCatalog(req(origin), { timeout: "50 millis" }))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])

    await settles(async () => (await codesOnDisk(origin))[0] === "CS 310")
  })

  // Running out of time with nothing behind it is still "could not ask", never "you have no courses".
  test("reports unreachable when it times out with no snapshot", async () => {
    const loaded = await Effect.runPromise(
      loadCatalog(req("https://cache-slow-empty.invalid"), { timeout: "250 millis" }),
    )
    expect(loaded.kind).toBe("unreachable")
  }, 30_000)
})

/**
 * ⚠ ONE REFRESH AT A TIME PER PROCESS. A refresh no longer ends with its caller, and a failure writes
 * nothing; with the gateway down, every guardrail check would otherwise queue another whole-catalogue
 * load on the lock behind the last.
 */
describe("loadCatalog's refreshes within one process", () => {
  test("callers that take any newer answer share the refresh already running", async () => {
    const seen: string[] = []
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.push(new URL(request.url).pathname)
        await Bun.sleep(100)
        // Not a status the client retries on its own, so each refresh asks exactly once.
        return json({ message: "refused" }, 403)
      },
    })
    const origin = server.url.origin
    await seed(origin, { courses: [course()], home, assistants: {}, models: [] }, 10 * 60_000)

    const loads = await Promise.all([1, 2, 3].map(() => Effect.runPromise(loadCatalog(req(origin)))))
    expect(loads.map((loaded) => loaded.kind === "ok" && loaded.error !== undefined)).toEqual([true, true, true])
    expect(seen.filter((pathname) => pathname === "/api/me/courses")).toHaveLength(1)
  })
})

/**
 * ⚠ A RE-ASK AFTER A REFUSED START MUST REACH THE GATEWAY. The refusal says the snapshot is wrong —
 * an assistant's window closed inside the TTL — so serving it again hands back the closed assistant.
 * A real local server rather than a stubbed client, because `loadCatalog` brings its own.
 */
describe("loadCatalog asked for a fresh answer", () => {
  const snapshot = { courses: [course({ code: "CS 101" })], assistants: { "7": [choice(12)] }, models: [] }

  test("refreshes a snapshot still inside its TTL", async () => {
    const seen: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        seen.push(pathname)
        if (pathname === "/api/me/courses") return json(listed([course()]))
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(13)])
      },
    })
    const origin = server.url.origin
    await seed(origin, snapshot)

    const cached = await Effect.runPromise(loadCatalog(req(origin)))
    expect(seen).toEqual([])
    expect(cached.kind === "ok" && cached.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])

    const loaded = await Effect.runPromise(loadCatalog(req(origin), { fresh: true }))
    expect(seen).toContain("/api/me/courses")
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.error).toBeUndefined()
    expect(loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 310"])
    expect(loaded.snapshot.assistants["7"]?.map((a) => a.id)).toEqual([13])
    // Written down, so the other process reads the same answer.
    expect(JSON.parse(await Bun.file(cacheFile(origin)).text()).courses[0].code).toBe("CS 310")
  })

  // Callers asking past the cache that queue on the lock take the one answer fetched after they both
  // asked, rather than loading the whole catalogue from the gateway once each.
  test("refreshes queued behind the lock share the fetch that began after they asked", async () => {
    const seen: string[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        seen.push(pathname)
        if (pathname === "/api/me/courses") return json(listed([course()]))
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(13)])
      },
    })
    const origin = server.url.origin
    await seed(origin, snapshot)

    const lock = await Flock.acquire(`jolli-catalog:${cacheFile(origin)}`)
    const loads = Promise.all([
      Effect.runPromise(loadCatalog(req(origin), { fresh: true })),
      Effect.runPromise(loadCatalog(req(origin), { fresh: true })),
    ])
    await Bun.sleep(50)
    await lock.release()

    const answers = await loads
    expect(seen.filter((pathname) => pathname === "/api/me/courses")).toHaveLength(1)
    expect(answers.map((loaded) => loaded.kind === "ok" && loaded.snapshot.courses[0]?.code)).toEqual([
      "CS 310",
      "CS 310",
    ])
  })

  /**
   * ⚠ A FETCH ALREADY UNDER WAY READ THE GATEWAY BEFORE THE NEW REQUEST WAS MADE. The request may be
   * a refused Start asking because the list just changed, so it waits out that fetch and makes its own.
   */
  test("a fetch already under way when a refresh is asked for does not answer it", async () => {
    const seen: string[] = []
    const gate = Promise.withResolvers<void>()
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        seen.push(pathname)
        if (pathname === "/api/me/courses") {
          if (seen.filter((item) => item === "/api/me/courses").length === 1) await gate.promise
          return json(listed([course()]))
        }
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(13)])
      },
    })
    const origin = server.url.origin
    await seed(origin, snapshot)

    const first = Effect.runPromise(loadCatalog(req(origin), { fresh: true }))
    while (!seen.includes("/api/me/courses")) await Bun.sleep(5)
    const second = Effect.runPromise(loadCatalog(req(origin), { fresh: true }))
    await Bun.sleep(20)
    gate.resolve()

    await Promise.all([first, second])
    expect(seen.filter((pathname) => pathname === "/api/me/courses")).toHaveLength(2)
  })

  // Asking past the cache does not give up the fallback: offline, the snapshot still serves.
  test("still serves the snapshot when the gateway cannot answer, with the failure beside it", async () => {
    const origin = "https://cache-fresh-offline.invalid"
    await seed(origin, snapshot)
    const loaded = await Effect.runPromise(loadCatalog(req(origin), { fresh: true, timeout: "5 seconds" }))
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.error).toBeDefined()
    expect(loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
  }, 30_000)
})

/**
 * ⚠ A SNAPSHOT SOME ORG DID NOT ANSWER IS PARTLY AS OLD AS THAT ORG'S LAST ANSWER, so it is asked
 * again sooner than the TTL — but behind the caller, which a slow org would otherwise hold up.
 */
describe("loadCatalog with an org that did not answer", () => {
  const serve = (unavailable: readonly object[]) => {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        seen.push(pathname)
        if (pathname === "/api/me/courses") return json(listed([course()], { unavailable }))
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(13)])
      },
    })
    return { seen, server }
  }

  /**
   * ⚠ A FACTORY, SO `fetchedAt` IS STAMPED WHEN THE TEST RUNS. Taken once when the file is collected,
   * the slow tests ahead of these could push it past the TTL and flip them onto the waiting path.
   */
  const partial = () => ({
    courses: [course({ code: "CS 101" })],
    assistants: {},
    models: [],
    home,
    unavailable: [org("bio")],
    fetchedAt: Date.now() - 2 * 60_000,
  })

  // Refreshed on every read, each message would start another wait on the org that keeps timing out.
  test("lets such a snapshot stand for the retry window", async () => {
    const http = serve([])
    using server = http.server
    const origin = server.url.origin
    await seed(origin, partial())

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(http.seen).toEqual([])
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
  })

  /**
   * ⚠ PAST THE RETRY WINDOW IT STILL ANSWERS, AND THE RETRY RUNS BEHIND IT. A guardrail check gives a
   * refresh five seconds and a slow org takes about that; waited for, it would cost a student's
   * message those seconds once a minute.
   */
  test("answers past the retry window and retries behind the answer", async () => {
    const http = serve([])
    using server = http.server
    const origin = server.url.origin
    await seed(origin, partial(), 2 * 60_000)

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])

    await settles(async () => (await codesOnDisk(origin))[0] === "CS 310")
    expect(http.seen).toContain("/api/me/courses")
  })

  // An attempt still waiting on a slow org has written nothing; the retry window counts from it anyway.
  test("spaces the next retry from an attempt still under way", async () => {
    const seen: string[] = []
    const gate = Promise.withResolvers<void>()
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        seen.push(pathname)
        await gate.promise
        if (pathname === "/api/me/courses") return json(listed([course()]))
        if (pathname === "/api/agent/models") return json(providers)
        return json([choice(13)])
      },
    })
    const origin = server.url.origin
    await seed(origin, partial(), 2 * 60_000)

    const first = await Effect.runPromise(loadCatalog(req(origin)))
    expect(first.kind === "ok" && first.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
    const lists = () => seen.filter((pathname) => pathname === "/api/me/courses").length
    await settles(() => lists() > 0)

    const second = await Effect.runPromise(loadCatalog(req(origin)))
    expect(second.kind === "ok" && second.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
    expect(lists()).toBe(1)

    // Let the retry land before the server and the snapshot go, so it outlives neither.
    gate.resolve()
    await settles(async () => (await codesOnDisk(origin))[0] === "CS 310")
  })

  /**
   * ⚠ THE RETRY IS ANSWERED BY ANY SNAPSHOT NEWER THAN THE ONE THAT STARTED IT. Another process can
   * write one between this read and the lock; its fetch began before this read, so "since requested"
   * would not take it, and the retry would load the whole catalogue again for nothing.
   */
  test("takes a snapshot another process wrote since, rather than retrying again", async () => {
    const http = serve([])
    using server = http.server
    const origin = server.url.origin
    await seed(origin, partial(), 2 * 60_000)

    const lock = await Flock.acquire(`jolli-catalog:${cacheFile(origin)}`)
    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
    // The other process's answer: begun before the read above, written while it waits on the lock.
    await seed(origin, { ...partial(), unavailable: undefined, fetchedAt: Date.now() - 1_000 })
    await lock.release()

    await Bun.sleep(200)
    expect(http.seen).toEqual([])
  })

  test("lets a snapshot incomplete several times in a row stand longer before retrying", async () => {
    const http = serve([])
    using server = http.server
    const origin = server.url.origin
    // The third incomplete answer in a row waits four minutes, not one.
    await seed(origin, { ...partial(), incompleteRuns: 3 }, 2 * 60_000)

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
    await Bun.sleep(100)
    expect(http.seen).toEqual([])
  })

  // A list kept from the last answer is as old as that answer: retried on the same terms as a missing org.
  test("retries a snapshot whose assistants it kept past the retry window", async () => {
    const http = serve([])
    using server = http.server
    const origin = server.url.origin
    await seed(
      origin,
      { ...partial(), unavailable: undefined, assistants: { "7": [choice(12)] }, assistantsKept: ["7"] },
      2 * 60_000,
    )

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 101"])
    await settles(async () => (await codesOnDisk(origin))[0] === "CS 310")
  })

  /**
   * ⚠ EACH ATTEMPT TOUCHES THE FILE, SO ITS MTIME CANNOT SAY HOW OLD THE ANSWER IS. Retries that kept
   * failing would otherwise keep it answering unasked for ever, and nobody would ever wait for one.
   */
  test("waits for the retry once the answer itself is past its TTL", async () => {
    const http = serve([])
    using server = http.server
    const origin = server.url.origin
    await seed(origin, { ...partial(), fetchedAt: Date.now() - 10 * 60_000 }, 2 * 60_000)

    const loaded = await Effect.runPromise(loadCatalog(req(origin)))
    expect(loaded.kind === "ok" && loaded.snapshot.courses.map((c) => c.code)).toEqual(["CS 310"])
  })

  /**
   * ⚠ A RETRY NOBODY WAITED FOR STILL HANDS ITS REFUSAL ON. `/jolli/course` renews the sign-in on a
   * 401; dropped with the background fiber, a revoked credential would go unnoticed behind a
   * snapshot that kept answering.
   */
  test("hands a refusal met behind an answer to the next read with the same token", async () => {
    using server = Bun.serve({ port: 0, fetch: () => json({ message: "unauthorized" }, 401) })
    const origin = server.url.origin
    await seed(origin, partial(), 2 * 60_000)

    const first = await Effect.runPromise(loadCatalog(req(origin)))
    expect(first.kind === "ok" && first.error).toBeUndefined()
    await settles(async () => {
      const next = await Effect.runPromise(loadCatalog(req(origin)))
      return next.kind === "ok" && next.error?.status === 401
    })
    // A renewed sign-in carries a new token, which that refusal says nothing about.
    const renewed = await Effect.runPromise(loadCatalog(req(origin, { token: "renewed" })))
    expect(renewed.kind === "ok" && renewed.error).toBeUndefined()
  })

  test("answers a fresh ask it could only partly refresh with the org it is missing", async () => {
    const http = serve([org("bio")])
    using server = http.server
    const origin = server.url.origin
    const loaded = await Effect.runPromise(loadCatalog(req(origin), { fresh: true }))
    written.push(cacheFile(origin))
    expect(loaded.kind).toBe("ok")
    if (loaded.kind !== "ok") return
    expect(loaded.snapshot.unavailable?.map((o) => o.orgSlug)).toEqual(["bio"])
    expect(loaded.error).toBeUndefined()
  })
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
      url.endsWith("/api/me/courses")
        ? json(listed([course()]))
        : url.endsWith("/api/agent/models")
          ? json(providers)
          : json([]),
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
