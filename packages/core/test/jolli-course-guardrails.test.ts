import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "../src/global"
import { gatewayRequest, type GatewayRequest } from "../src/jolli/api"
import { CATALOG_SCHEMA, catalogCachePath } from "../src/jolli/cache"
import { JolliCourseGuardrails } from "../src/jolli/course-guardrails"
import { JolliSession } from "../src/jolli/session"

const binding = { courseId: "7", assistantId: "12" }
const request = (origin: string): GatewayRequest => ({ origin, token: "jwt", identity: "student-a" })
const written: string[] = []

/** A fresh catalogue on disk, so the read is answered without a network round trip. */
async function seedCatalog(origin: string, assistants: Record<string, unknown[]>) {
  const file = catalogCachePath(request(origin))
  await mkdir(Global.Path.cache, { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      schema: CATALOG_SCHEMA,
      courses: [
        {
          id: 7,
          name: "Systems Programming",
          description: "From the catalogue.",
          code: "CS 310",
          status: "published",
          requiresCoding: true,
          endsOn: null,
          viewerRole: "course-student",
          isStaff: false,
        },
      ],
      assistants,
      models: [],
    }),
  )
  written.push(file)
}

const choice = (id: number, showCitations: boolean) => ({
  id,
  name: "Pair programmer",
  blurb: "Works through the problem with you",
  icon: "Terminal",
  accent: 0,
  worksThroughProblems: true,
  answersFromMaterialsOnly: true,
  showCitations,
  modelId: "uuid-opus",
  allowedModelIds: ["uuid-opus"],
})

afterEach(async () => {
  await Promise.all(written.splice(0).map((file) => rm(file, { force: true })))
})

describe("JolliCourseGuardrails.resolve", () => {
  test("reads the bound assistant's switches off the student's catalogue", async () => {
    const origin = "https://course-guardrails.invalid"
    await seedCatalog(origin, { "7": [choice(12, true)] })
    const guardrails = await Effect.runPromise(JolliCourseGuardrails.resolve({ request: request(origin), binding }))
    expect(guardrails).toMatchObject({ restrictToMaterials: true, showCitations: true })
  })

  test("does not know an assistant the catalogue does not hold for this course", async () => {
    const origin = "https://course-guardrails-unknown.invalid"
    await seedCatalog(origin, { "7": [choice(99, true)] })
    const guardrails = await Effect.runPromise(JolliCourseGuardrails.resolve({ request: request(origin), binding }))
    expect(guardrails).toBeUndefined()
  })

  test("does not know anything without a credential", async () => {
    expect(await Effect.runPromise(JolliCourseGuardrails.resolve({ request: undefined, binding }))).toBeUndefined()
  })
})

describe("JolliCourseGuardrails.ofBinding", () => {
  /** This process's session, answering with `request` for the credential. */
  function signedIn(request: JolliSession.Interface["request"]) {
    const unused = () => Effect.die("not used by this read")
    return JolliSession.Service.of({
      current: () => Effect.succeed(undefined),
      token: unused,
      request,
      refused: unused,
      signIn: unused,
      signOut: unused,
    })
  }

  test("reads the switches with the credential this process holds", async () => {
    const origin = "https://course-guardrails-binding.invalid"
    await seedCatalog(origin, { "7": [choice(12, true)] })
    const guardrails = await Effect.runPromise(
      JolliCourseGuardrails.ofBinding(binding).pipe(
        Effect.provideService(
          JolliSession.Service,
          signedIn(() => Effect.succeed(request(origin))),
        ),
      ),
    )
    expect(guardrails).toMatchObject({ showCitations: true })
  })

  /**
   * ⚠ OFF THE STORED ROW, NEVER `request()`. That renews a token near its expiry — a round trip to
   * the auth hub in front of creating the session a student's first message goes into.
   */
  test("reads whether the bound assistant speaks first, without asking for a fresh token", async () => {
    const origin = "https://course-guardrails-opens.jolli.dev"
    await seedCatalog(origin, { "7": [{ ...choice(12, false), opensConversation: true }, choice(13, false)] })
    const session = JolliSession.Service.of({
      ...signedIn(() => Effect.die("a fresh token was asked for")),
      current: () =>
        Effect.succeed({
          id: "row",
          subject: null,
          email: null,
          base_url: origin,
          access_token: "expiring-jwt",
          refresh_token: "refresh",
          token_expiry: Date.now(),
          cache_key: "student-a",
          time_created: 0,
          time_updated: 0,
        }),
    })
    const opens = (assistantId: string) =>
      Effect.runPromise(
        JolliCourseGuardrails.opensConversation({ courseId: "7", assistantId }).pipe(
          Effect.provideService(JolliSession.Service, session),
        ),
      )
    expect(await opens("12")).toBe(true)
    expect(await opens("13")).toBe(false)
    expect(await opens("99")).toBeUndefined()
  })

  test("does not know anything, and does not fail, when the credential cannot be read", async () => {
    const guardrails = await Effect.runPromise(
      JolliCourseGuardrails.ofBinding(binding).pipe(
        Effect.provideService(
          JolliSession.Service,
          signedIn(() => Effect.fail(new JolliSession.JolliUnavailable({ message: "offline" }))),
        ),
      ),
    )
    expect(guardrails).toBeUndefined()
  })
})

describe("JolliCourseGuardrails.assignmentsIncluded", () => {
  afterEach(() => {
    setSystemTime()
  })

  /** A gateway answering the assistant choices with `reply`, counting the reads it is sent. */
  function gateway(reply: () => Response) {
    const reads: string[] = []
    const fetch = ((input: string | URL | Request) => {
      reads.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(reply())
    }) as typeof globalThis.fetch
    return { reads, fetch }
  }

  const choices = (includeAssignments: boolean) =>
    new Response(JSON.stringify([{ ...choice(12, false), includeAssignments }]), {
      headers: { "content-type": "application/json" },
    })

  /** The stored credential for `baseUrl`, whose origin and tenant a reading is filed under. */
  const stored = (baseUrl: string) => ({
    id: "row",
    subject: null,
    email: null,
    base_url: baseUrl,
    access_token: "jwt",
    refresh_token: "refresh",
    token_expiry: Date.now(),
    cache_key: "student-a",
    time_created: 0,
    time_updated: 0,
  })

  /**
   * Whether the switch reads as on, with the credential stored for `baseUrl`, a renewal answering
   * `renewed` (by default a token for that same account), and the gateway behind `fetch`.
   */
  function included(
    baseUrl: string,
    fetch: typeof globalThis.fetch,
    renewed: JolliSession.Interface["request"] = () =>
      Effect.succeed(gatewayRequest(baseUrl, { token: "jwt", identity: "student-a" })),
  ) {
    const unused = () => Effect.die("not used by this read")
    return Effect.runPromise(
      JolliCourseGuardrails.assignmentsIncluded(binding).pipe(
        Effect.provideService(
          JolliSession.Service,
          JolliSession.Service.of({
            current: () => Effect.succeed(stored(baseUrl)),
            token: unused,
            request: renewed,
            refused: unused,
            signIn: unused,
            signOut: unused,
          }),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    )
  }

  // Asked before every model step: a turn of many steps reads the gateway once, not once a step.
  test("reads the switch once for the steps of a turn", async () => {
    const origin = "https://assignments-once.jolli.dev"
    const http = gateway(() => choices(true))
    expect(await included(origin, http.fetch)).toBe(true)
    expect(await included(origin, http.fetch)).toBe(true)
    expect(http.reads).toHaveLength(1)
  })

  /**
   * ⚠ ONE FAILED READ MUST NOT TAKE THE TOOL AWAY MID-TURN. The tool list is rebuilt every step, so
   * withholding on a failure would drop the tool and hand it back a step later.
   */
  test("keeps the last answer when a later read fails, and withholds only what was never read", async () => {
    const origin = "https://assignments-kept.jolli.dev"
    expect(await included(origin, gateway(() => choices(true)).fetch)).toBe(true)
    setSystemTime(new Date(Date.now() + 60_000))
    const failing = gateway(() => new Response("unavailable", { status: 503 }))
    expect(await included(origin, failing.fetch)).toBe(true)
    expect(failing.reads).toContain(`${origin}/api/courses/7/assistant-choices`)

    expect(await included("https://assignments-new.jolli.dev", failing.fetch)).toBe(false)
  })

  // The reading is found by the stored credential, so a renewal that is slow or failing — the moment
  // the last answer is wanted — still finds it.
  test("keeps the last answer when the credential cannot be renewed", async () => {
    const origin = "https://assignments-renewal.jolli.dev"
    expect(await included(origin, gateway(() => choices(true)).fetch)).toBe(true)
    setSystemTime(new Date(Date.now() + 60_000))
    const unread = gateway(() => choices(false))
    const offline = () => Effect.fail(new JolliSession.JolliUnavailable({ message: "offline" }))
    expect(await included(origin, unread.fetch, offline)).toBe(true)
    expect(unread.reads).toEqual([])
  })

  /**
   * With the gateway down, every caller waiting out a timeout of its own would cost each step and each
   * code-mode call the whole timeout. One read serves the callers that arrive while it runs, and a
   * failed one answers for the TTL as a successful one does.
   */
  test("shares one read among concurrent callers, and holds a failed read for the TTL", async () => {
    const origin = "https://assignments-shared.jolli.dev"
    const failing = gateway(() => new Response("unavailable", { status: 503 }))
    expect(await Promise.all([included(origin, failing.fetch), included(origin, failing.fetch)])).toEqual([
      false,
      false,
    ])
    const reads = failing.reads.length
    expect(await included(origin, failing.fetch)).toBe(false)
    expect(failing.reads).toHaveLength(reads)
  })

  // Two tenants on one origin can hold the same course and assistant ids.
  test("files a reading under its tenant, not only its origin", async () => {
    const http = gateway(() => choices(true))
    expect(await included("https://assignments-tenants.jolli.dev/north", http.fetch)).toBe(true)
    expect(await included("https://assignments-tenants.jolli.dev/south", http.fetch)).toBe(true)
    expect(http.reads).toHaveLength(2)
  })

  test("reads again once the last reading is old, so a teacher's change reaches the next turn", async () => {
    const origin = "https://assignments-stale.jolli.dev"
    expect(await included(origin, gateway(() => choices(true)).fetch)).toBe(true)
    setSystemTime(new Date(Date.now() + 60_000))
    expect(await included(origin, gateway(() => choices(false)).fetch)).toBe(false)
  })
})
