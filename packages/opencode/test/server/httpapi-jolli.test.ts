import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect } from "bun:test"
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Global } from "@opencode-ai/core/global"
import { catalogCachePath } from "@opencode-ai/core/jolli/cache"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Hash } from "@opencode-ai/core/util/hash"
import { Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { gatewayRequest } from "@opencode-ai/core/jolli/api"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { JolliStore } from "@opencode-ai/core/jolli/store"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { JolliPaths } from "../../src/server/routes/instance/httpapi/groups/jolli"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { jolliHandlers } from "../../src/server/routes/instance/httpapi/handlers/jolli"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

/** What files a catalogue snapshot. Stable across token rotation — see `GatewayRequest.identity`. */
const IDENTITY = "student-a"

/**
 * ⚠ THE SESSION SERVICE IS MOCKED DOWN TO `request()`, WHICH IS ALL THIS HANDLER USES. Every case
 * below is one the renderer actually meets before a student has signed in — the session screen asks
 * for this catalogue whether or not there is a credential — and all of them must answer rather than
 * fail.
 *
 * ⚠ THE MOCK BUILDS ITS REQUEST WITH THE REAL `gatewayRequest`, so the allowlist refusal below is
 * still the product's refusal rather than the test's.
 */
function apiLayer(
  credential?: { baseUrl?: string; token?: string; subject?: string; email?: string },
  refused?: (token: string) => void,
  gateway: typeof globalThis.fetch = globalThis.fetch,
) {
  const request =
    credential?.baseUrl && credential.token
      ? gatewayRequest(credential.baseUrl, { token: credential.token, identity: IDENTITY })
      : undefined
  /**
   * ⚠ `current()` IS MOCKED SEPARATELY FROM `request()` BECAUSE THE HANDLER READS THEM SEPARATELY,
   * and that separation is the behaviour under test: the viewer comes off the stored token without
   * touching the network, so a credential with no `baseUrl` still names the student while
   * `request()` answers nothing.
   */
  const row = credential?.token
    ? ({
        id: "test",
        /**
         * ⚠ NULL UNLESS A CASE ASKS FOR ONE, WHICH IS WHAT KEEPS THE WHOLE-BODY `toEqual`S IN THIS
         * FILE GREEN. `account` is filed off these two columns and is omitted when there is neither.
         */
        subject: credential.subject ?? null,
        email: credential.email ?? null,
        base_url: credential.baseUrl ?? null,
        access_token: credential.token,
        refresh_token: null,
        token_expiry: null,
        cache_key: IDENTITY,
        time_created: 0,
        time_updated: 0,
      } satisfies JolliStore.Row)
    : undefined
  return HttpRouter.serve(
    HttpApiBuilder.layer(RootHttpApi).pipe(
      Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, jolliHandlers]),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(
      Layer.mock(JolliSession.Service)({
        current: () => Effect.succeed(row),
        request: () => Effect.succeed(request),
        /**
         * ⚠ DECLARED EVEN WHERE NO CASE CALLS IT, because the handler reaches for it on a refused
         * catalogue and `Layer.mock` throws for anything it was not given — a 401 would surface as
         * a crashed route rather than as the "unreachable" every other failure answers with.
         */
        refused: (token: string) => Effect.sync(() => refused?.(token)).pipe(Effect.as(token)),
      }),
    ),
    // `controlHandlers` shares this router and still owns every other provider's credentials.
    Layer.provide(Layer.mock(Auth.Service)({})),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(Layer.mock(Installation.Service)({})),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
    /**
     * ⚠ THE `Fetch` REFERENCE, NOT `globalThis.fetch`. `loadCatalog` provides `FetchHttpClient`
     * itself, and that client reads this reference off the fiber — so a global stub is simply not
     * consulted and the case below makes a real DNS lookup instead. Overriding the reference is
     * also the only way to stub this without touching `globalThis`.
     */
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, gateway)),
  )
}

const signedOut = testEffect(apiLayer())

/**
 * ⚠ THE WHOLE-BODY ASSERTIONS IN THIS FILE NOW DEPEND ON `"jwt"` NOT BEING A JWT. The route answers
 * with an optional `viewer` decoded from the credential; the literal `"jwt"` these cases use as a
 * key has no `.` segments, so nothing decodes and the field is omitted rather than sent. If a future
 * edit makes those fixtures look like real tokens, these `toEqual`s will start failing for a reason
 * that has nothing to do with what they are testing.
 */
describe("jolli HttpApi", () => {
  signedOut.live("answers unreachable rather than failing when signed out", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ status: "unreachable", courses: [], assistants: [], modelTiers: {} })
    }),
  )
})

/** A syntactically real JWT whose payload we control. Never signed; nothing here verifies one. */
function fakeToken(payload: Record<string, unknown>) {
  return `${base64Encode(JSON.stringify({ alg: "RS256" }))}.${base64Encode(JSON.stringify(payload))}.signature`
}

const withIdentity = (payload: Record<string, unknown>) => testEffect(apiLayer({ token: fakeToken(payload) }))

/**
 * WHO IS SIGNED IN SURVIVES AN UNREACHABLE GATEWAY.
 *
 * ⚠ THAT IS THE WHOLE POINT OF THE ORDERING IN THE HANDLER, AND IT IS WHAT THESE CASES PIN. Every
 * credential below has no `baseUrl`, so the route answers `unreachable` — and still names the
 * student, because the name came out of the token rather than off the network. Decoding after the
 * reachability guards would blank a student's own name because their Wi-Fi dropped.
 */
describe("jolli HttpApi — the viewer", () => {
  withIdentity({ name: "Ada Lovelace", email: "ada@jolli.ai" }).live("names the student from the token", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(yield* response.json).toEqual({
        status: "unreachable",
        courses: [],
        assistants: [],
        modelTiers: {},
        viewer: { name: "Ada Lovelace", email: "ada@jolli.ai" },
      })
    }),
  )

  withIdentity({ email: "ada@jolli.ai" }).live("falls back to the address when there is no name", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      const body = (yield* response.json) as { viewer?: { name?: string; email?: string } }
      expect(body.viewer).toEqual({ name: "ada", email: "ada@jolli.ai" })
    }),
  )

  withIdentity({ name: "李雷" }).live("carries a non-ASCII name through unmangled", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      const body = (yield* response.json) as { viewer?: { name?: string } }
      expect(body.viewer?.name).toBe("李雷")
    }),
  )

  /** ⚠ OMITTED, NOT NULL. `optional` drops `undefined` on encode, which is what keeps the cases above green. */
  withIdentity({ sub: "user_123" }).live("omits the field entirely when the token will not say", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(yield* response.json).toEqual({ status: "unreachable", courses: [], assistants: [], modelTiers: {} })
    }),
  )
})

/**
 * WHOSE CATALOGUE THIS IS, FOR A CLIENT THAT HAS SOMETHING TO FILE UNDER IT.
 *
 * ⚠ IT COMES OFF THE ROW, NOT THE TOKEN, AND THE CASE ABOVE IS WHY THAT IS VISIBLE HERE. A payload
 * carrying `sub: "user_123"` produces no `account` at all when the stored credential records no
 * subject — the claim is the viewer's business and `Jolli.Catalog.account` is the store's.
 */
describe("jolli HttpApi — the account", () => {
  const withAccount = (subject?: string, email?: string) =>
    testEffect(apiLayer({ token: "jwt", ...(subject ? { subject } : {}), ...(email ? { email } : {}) }))

  withAccount("user_123").live("names the account from the stored subject", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      const body = (yield* response.json) as { account?: string }
      expect(body.account).toBe("user_123")
    }),
  )

  /** ⚠ THE FALLBACK, FOR A BACKEND THAT REPORTS NO SUBJECT. An address still tells two students apart. */
  withAccount(undefined, "ada@jolli.ai").live("falls back to the stored address", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      const body = (yield* response.json) as { account?: string }
      expect(body.account).toBe("ada@jolli.ai")
    }),
  )

  /** ⚠ THE SUBJECT OUTRANKS THE ADDRESS, because an address can be changed and still be the same student. */
  withAccount("user_123", "ada@jolli.ai").live("prefers the subject over the address", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      const body = (yield* response.json) as { account?: string }
      expect(body.account).toBe("user_123")
    }),
  )

  /**
   * ⚠ OMITTED RATHER THAN GUESSED. A client that files a preference under this has to be told when
   * two people would share the bucket; inventing a key here would hide that from it.
   */
  withAccount().live("says nothing when the credential names nobody", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(yield* response.json).toEqual({ status: "unreachable", courses: [], assistants: [], modelTiers: {} })
    }),
  )
})

/**
 * ⚠ A CREDENTIAL WITHOUT A TENANT IS THE SAME EMPTY ANSWER, NOT AN ATTEMPT. `cli-exchange` on an
 * older backend reports no `baseUrl`, and there is no origin to guess — Brand.gatewayUrl is a
 * gateway root, which mounts the model routes but is not known to serve a course list.
 */
const noTenant = testEffect(apiLayer({ token: "jwt" }))

describe("jolli HttpApi — credential without a tenant", () => {
  noTenant.live("answers unreachable rather than guessing an origin", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ status: "unreachable", courses: [], assistants: [], modelTiers: {} })
    }),
  )
})

/**
 * ⚠ A TENANT OUTSIDE THE ALLOWLIST IS NOT CALLED, AND THE REFUSAL IS SILENT. A stored `baseUrl` is
 * not trusted just because it was stored — this request carries the student's JWT — and the screen
 * asking has an empty state that already reads correctly.
 */
const strangeTenant = testEffect(apiLayer({ token: "jwt", baseUrl: "https://evil.example" }))

describe("jolli HttpApi — a tenant outside the allowlist", () => {
  strangeTenant.live("answers unreachable rather than sending the credential there", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ status: "unreachable", courses: [], assistants: [], modelTiers: {} })
    }),
  )
})

/**
 * ⚠ THE CACHE IS SEEDED RATHER THAN THE GATEWAY STUBBED, because that is how this route actually
 * gets its answer: the desktop's main process writes the snapshot before the sidecar forks, and
 * this handler reads it. A fresh file is served with no request at all.
 */
const TENANT = "https://httpapi-jolli.jolli.ai"
const TOKEN = "jwt"
/**
 * ⚠ THE REAL FUNCTION RATHER THAN A MIRROR OF IT. A test that recomputed the key would keep passing
 * while agreeing with nothing — it would seed the path IT chose, not the one the product reads. It
 * did recompute it, and the day the key stopped being the token was the day that would have shown.
 */
const cacheFile = catalogCachePath({ origin: TENANT, token: TOKEN, identity: IDENTITY })

await mkdir(Global.Path.cache, { recursive: true })
await writeFile(
  cacheFile,
  JSON.stringify({
    schema: 2,
    courses: [
      {
        id: 7,
        name: "Systems Programming",
        description: "Pointers and their consequences",
        code: "CS 310",
        status: "published",
        requiresCoding: true,
        endsOn: null,
        viewerRole: "course-student",
        isStaff: false,
      },
    ],
    assistants: {
      "7": [
        {
          id: 12,
          name: "Pair programmer",
          blurb: "Works through the problem with you",
          icon: "Terminal",
          accent: 0,
          worksThroughProblems: true,
          answersFromMaterialsOnly: false,
          showCitations: true,
          modelId: "uuid-opus",
          allowedModelIds: ["uuid-opus"],
        },
      ],
    },
    models: [
      {
        id: "uuid-opus",
        name: "claude-opus-4-8",
        category: "Premium",
        description: null,
        isActive: true,
        protocol: "anthropic",
      },
    ],
  }),
)
afterAll(() => rm(cacheFile, { force: true }))

const enrolled = testEffect(apiLayer({ token: TOKEN, baseUrl: TENANT }))

describe("jolli HttpApi — a signed-in student", () => {
  /**
   * ⚠ WHAT CROSSES THIS BOUNDARY IS A COURSE, NOT THE GATEWAY'S SHAPES. Registry UUIDs become
   * opencode model keys, numeric ids become strings, and `viewerRole` never appears at all.
   */
  enrolled.live("maps the cached catalogue into the shapes the renderer renders", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      const body = (yield* response.json) as {
        status: string
        courses: { id: string; code: string; entryState: string; assistantIds: string[] }[]
        assistants: { id: string; courseId: string; isDefault?: boolean; allowedModelIds: string[] }[]
        modelTiers: Record<string, string>
      }
      /**
       * ⚠ THE ONLY ANSWER THAT MAY SAY `ok`. Every branch that never reached the gateway reports
       * `unreachable` above, which is what stops an empty list being read as "you are enrolled in
       * nothing" when it means "we could not ask".
       */
      expect(body.status).toBe("ok")
      expect(body.courses).toHaveLength(1)
      expect(body.courses[0]).toMatchObject({ id: "7", code: "CS 310", assistantIds: ["12"] })
      // Computed per request against today, never read from the snapshot.
      expect(body.courses[0]?.entryState).toBe("open")
      expect(body.assistants[0]).toMatchObject({ id: "12", courseId: "7", isDefault: true })
      expect(body.assistants[0]?.allowedModelIds).toEqual(["jolli-anthropic/uuid-opus"])
      expect(body.modelTiers).toEqual({ "jolli-anthropic/uuid-opus": "premium" })
    }),
  )
})

/**
 * A CREDENTIAL THE GATEWAY REFUSES, WHICH IS NOT THE SAME THING AS AN OUTAGE.
 *
 * ⚠ THE STUDENT WHO NEVER SENDS A MESSAGE IS THE WHOLE REASON THIS PATH EXISTS. The model call
 * reaches the refresh path on its own 401; somebody who only opens the app would otherwise sit in
 * front of an empty course list until their token expired — up to three days of being told nothing
 * is reachable when the real answer is that their sign-in ended.
 *
 * ⚠ A TENANT OF ITS OWN, NOT JUST A TOKEN OF ITS OWN. `catalogCachePath` keys on the origin and the
 * stable `identity`, deliberately NOT on the access token — a rotating token must not orphan the
 * snapshot. So a second credential at the same tenant reads the seeded file above and answers `ok`
 * without ever reaching the gateway, which is exactly what this case needs not to happen.
 */
const REFUSED_TENANT = "https://httpapi-jolli-refused.jolli.ai"
const REFUSED_TOKEN = "refused-jwt"
const refusals: string[] = []
/**
 * A GATEWAY THAT REFUSES ONE TENANT AND NOTHING ELSE.
 *
 * ⚠ ONLY THE TENANT IS ANSWERED HERE. The test client reaches its own server through this same
 * reference, so a stub that refused everything would 401 the request under test before it ever
 * reached the route.
 */
// Asserted because `typeof fetch` carries `preconnect`, which a stub has no business having.
const refusing = (tenant: string) =>
  (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.startsWith(tenant)) return new Response("", { status: 401 })
    return globalThis.fetch(input, init)
  }) as typeof fetch

const refusedByGateway = testEffect(
  apiLayer(
    { token: REFUSED_TOKEN, baseUrl: REFUSED_TENANT },
    (token) => refusals.push(token),
    refusing(REFUSED_TENANT),
  ),
)

describe("jolli HttpApi — a credential the gateway refuses", () => {
  refusedByGateway.live("renews rather than reporting an outage it is not", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      // This request is already lost either way; what renewing decides is what the NEXT one sees —
      // a working token, or a deleted credential and a screen that says to sign in.
      expect(yield* response.json).toMatchObject({ status: "unreachable" })
      expect(refusals).toEqual([REFUSED_TOKEN])
    }),
  )
})

/**
 * THE SAME REFUSAL, FOR THE STUDENT WHO HAS ACTUALLY BEEN USING THE PRODUCT.
 *
 * ⚠ A SNAPSHOT ON DISK TURNS THE REFUSAL INTO AN `ok`, AND THAT IS WHY THIS CASE EXISTS SEPARATELY.
 * `cache.ts` serves what it has when a refresh fails — right for an outage, and right here too —
 * but the renewal above only ran on the failure branch, so it ran for the student with an empty
 * cache and never for the one with a stale one. Whose screen, meanwhile, looked entirely normal:
 * yesterday's courses, listed as `ok`, behind a credential the backend had already retired.
 */
const STALE_TENANT = "https://httpapi-jolli-stale.jolli.ai"
const STALE_TOKEN = "stale-jwt"
const staleRefusals: string[] = []
const staleFile = catalogCachePath({ origin: STALE_TENANT, token: STALE_TOKEN, identity: IDENTITY })

await writeFile(staleFile, await readFile(cacheFile, "utf8"))
// Older than the five-minute TTL, so the refresh that meets the 401 actually happens.
await utimes(staleFile, new Date(Date.now() - 60 * 60_000), new Date(Date.now() - 60 * 60_000))
afterAll(() => rm(staleFile, { force: true }))

const refusedWithSnapshot = testEffect(
  apiLayer({ token: STALE_TOKEN, baseUrl: STALE_TENANT }, (token) => staleRefusals.push(token), refusing(STALE_TENANT)),
)

describe("jolli HttpApi — a refused credential with a catalogue still on disk", () => {
  refusedWithSnapshot.live("serves the stale answer AND still renews", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      // Serving what we have is not in question — a student on a train needs it. Doing it silently is.
      expect(yield* response.json).toMatchObject({ status: "ok" })
      expect(staleRefusals).toEqual([STALE_TOKEN])
    }),
  )
})

/**
 * THE SHARE ROUTES, AGAINST A STUB GATEWAY.
 *
 * ⚠ THE STUB ANSWERS BY METHOD AND PATH, THE WAY JOLLIEDU ROUTES THEM, so each case states the
 * gateway's side of the exchange rather than a call count.
 *
 * ⚠ AND IT ANSWERS ONLY THE GATEWAY'S HOST. The `Fetch` reference it replaces is also what this
 * test's own client reads to reach the server under test, so anything else goes to the real fetch.
 */
type GatewayCall = { method: string; path: string; body?: unknown }

function gatewayStub(answer: (call: GatewayCall) => Response) {
  const calls: GatewayCall[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname !== "acme.jolli.ai") return globalThis.fetch(request)
    const text = await request.text()
    const call = {
      method: request.method,
      path: new URL(request.url).pathname,
      ...(text ? { body: JSON.parse(text) } : {}),
    }
    calls.push(call)
    return answer(call)
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const VISIBILITY = {
  courseCode: "CS 310",
  courseId: 7,
  mayControl: true,
  shares: [{ subjectIsClass: false, subjectUserId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", access: "view" }],
}

const ROSTER = [
  { userId: 1, role: "course-student", userName: "Ada Lovelace", userEmail: "ada@jolli.ai" },
  { userId: 2, role: "course-instructor", userName: "Grace Hopper", userEmail: "grace@jolli.ai" },
  { userId: 3, role: "course-student", userName: "Alan Turing", userEmail: "alan@jolli.ai" },
]

const signedInAs = (fetch: typeof globalThis.fetch) =>
  testEffect(
    apiLayer({ baseUrl: "https://acme.jolli.ai", token: fakeToken({ email: "ada@jolli.ai" }) }, undefined, fetch),
  )

const sharePath = (sessionID: string) => JolliPaths.share.replace(":sessionID", sessionID)

describe("jolli HttpApi — session share", () => {
  signedOut.live("answers unreachable rather than failing when signed out", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(sharePath("ses_1")).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        status: "unreachable",
        courseId: null,
        courseCode: null,
        readers: [],
        members: [],
        classSize: 0,
        roster: "unavailable",
      })
    }),
  )

  const read = gatewayStub((call) =>
    call.path === "/api/agent/convos/ses_1" ? reply({ visibility: VISIBILITY }) : reply(ROSTER),
  )
  signedInAs(read.fetch).live("reads the readers and the roster, without the student themself", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(sharePath("ses_1")).pipe(HttpClient.execute)
      expect(yield* response.json).toEqual({
        status: "ok",
        courseId: 7,
        courseCode: "CS 310",
        readers: [{ kind: "person", userId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", access: "view" }],
        members: [
          { userId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", kind: "staff" },
          { userId: 3, name: "Alan Turing", detail: "alan@jolli.ai", kind: "student" },
        ],
        // Ada and Alan: the signed-in student is still one of the class.
        classSize: 2,
        roster: "ok",
      })
      expect(read.calls.map((call) => call.path)).toEqual(["/api/agent/convos/ses_1", "/api/spaces/7/members"])
    }),
  )

  /** ⚠ 404 IS A SESSION THE GATEWAY HAS NOT SEEN YET, NOT AN OUTAGE — the panel words the two apart. */
  const unsynced = gatewayStub(() => reply({ error: "Conversation not found" }, 404))
  signedInAs(unsynced.fetch).live("answers unsynced for a conversation the gateway does not have", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(sharePath("ses_new")).pipe(HttpClient.execute)
      expect(((yield* response.json) as { status: string }).status).toBe("unsynced")
      expect(unsynced.calls).toHaveLength(1)
    }),
  )

  /** ⚠ THE GRANTS ARE THE HALF THAT MATTERS; A ROSTER FAILURE ONLY EMPTIES THE PICKER. */
  const noRoster = gatewayStub((call) =>
    call.path.startsWith("/api/agent/convos/") ? reply({ visibility: VISIBILITY }) : reply({ error: "boom" }, 500),
  )
  signedInAs(noRoster.fetch).live("keeps the readers when the roster cannot be read", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(sharePath("ses_1")).pipe(HttpClient.execute)
      const body = (yield* response.json) as { status: string; readers: unknown[]; members: unknown[]; roster: string }
      expect(body.status).toBe("ok")
      expect(body.readers).toHaveLength(1)
      expect(body.members).toEqual([])
      expect(body.roster).toBe("unavailable")
    }),
  )

  const readersPath = (sessionID: string) => JolliPaths.shareReaders.replace(":sessionID", sessionID)

  /** ⚠ THE HEADER'S READ: THE READERS ALONE, ANSWERED AS A WRITE IS — NO TIMELINE AND NO ROSTER. */
  const readers = gatewayStub(() => reply(VISIBILITY))
  signedInAs(readers.fetch).live("reads the readers alone from the shares route", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(readersPath("ses_1")).pipe(HttpClient.execute)
      expect(yield* response.json).toEqual({
        status: "ok",
        courseId: 7,
        courseCode: "CS 310",
        readers: [{ kind: "person", userId: 2, name: "Grace Hopper", detail: "grace@jolli.ai", access: "view" }],
        members: [],
        classSize: 0,
        roster: "unavailable",
      })
      expect(readers.calls).toEqual([{ method: "GET", path: "/api/agent/convos/ses_1/shares" }])
    }),
  )

  const readersUnsynced = gatewayStub(() => reply({ error: "Conversation not found" }, 404))
  signedInAs(readersUnsynced.fetch).live("answers unsynced on the shares route's own 404", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(readersPath("ses_new")).pipe(HttpClient.execute)
      expect(((yield* response.json) as { status: string }).status).toBe("unsynced")
      expect(readersUnsynced.calls.map((call) => call.path)).toEqual(["/api/agent/convos/ses_new/shares"])
    }),
  )

  const add = gatewayStub(() => reply(VISIBILITY))
  signedInAs(add.fetch).live("writes a grant at the one writable level", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(sharePath("ses_1")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ subject: 2 }),
        HttpClient.execute,
      )
      const body = (yield* response.json) as { status: string; readers: unknown[]; members: unknown[] }
      expect(body.status).toBe("ok")
      expect(body.readers).toHaveLength(1)
      expect(add.calls).toEqual([
        { method: "POST", path: "/api/agent/convos/ses_1/shares", body: { subjectUserId: 2, access: "view" } },
      ])
    }),
  )

  const refused = gatewayStub(() => reply({ error: "nope", code: "subject_not_in_course" }, 400))
  signedInAs(refused.fetch).live("words a refusal as its code", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(sharePath("ses_1")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ subject: 99 }),
        HttpClient.execute,
      )
      const body = (yield* response.json) as { status: string; refusal?: string }
      expect(body.status).toBe("refused")
      expect(body.refusal).toBe("subject_not_in_course")
    }),
  )

  const remove = gatewayStub(() => reply({ ...VISIBILITY, shares: [] }))
  signedInAs(remove.fetch).live("takes the class grant back by its literal", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.delete(`${sharePath("ses_1")}/everyone`).pipe(HttpClient.execute)
      expect(((yield* response.json) as { readers: unknown[] }).readers).toEqual([])
      expect(remove.calls).toEqual([{ method: "DELETE", path: "/api/agent/convos/ses_1/shares/everyone" }])
    }),
  )

  const never = gatewayStub(() => reply({}))
  signedInAs(never.fetch).live("refuses a malformed subject without asking the gateway", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.delete(`${sharePath("ses_1")}/nobody`).pipe(HttpClient.execute)
      expect(((yield* response.json) as { status: string }).status).toBe("refused")
      expect(never.calls).toEqual([])
    }),
  )

  const neverAdd = gatewayStub(() => reply({}))
  signedInAs(neverAdd.fetch).live("refuses a grant to a user id that cannot exist without asking the gateway", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(sharePath("ses_1")).pipe(
        HttpClientRequest.bodyJsonUnsafe({ subject: 0 }),
        HttpClient.execute,
      )
      expect(((yield* response.json) as { status: string }).status).toBe("refused")
      expect(neverAdd.calls).toEqual([])
    }),
  )
})
