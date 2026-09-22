import { NodeHttpServer } from "@effect/platform-node"
import { afterAll, describe, expect } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
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

/**
 * ⚠ THE AUTH SERVICE IS MOCKED EMPTY ON PURPOSE. Every case below is one the renderer actually
 * meets before a student has signed in — the session screen asks for this catalogue whether or not
 * there is a credential — and all of them must answer rather than fail.
 */
function apiLayer(auth: Partial<Context.Service.Shape<typeof Auth.Service>> = {}) {
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
    Layer.provide(Layer.mock(Auth.Service)(auth)),
    Layer.provide(Layer.mock(Config.Service)({})),
    Layer.provide(Layer.mock(MoveSession.Service)({})),
    Layer.provide(Layer.mock(Installation.Service)({})),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
  )
}

const signedOut = testEffect(apiLayer({ get: () => Effect.succeed(undefined) }))

describe("jolli HttpApi", () => {
  signedOut.live("answers unreachable rather than failing when signed out", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(JolliPaths.course).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ status: "unreachable", courses: [], assistants: [], modelTiers: {} })
    }),
  )
})

/**
 * ⚠ A CREDENTIAL WITHOUT A TENANT IS THE SAME EMPTY ANSWER, NOT AN ATTEMPT. `cli-exchange` on an
 * older backend reports no `baseUrl`, and there is no origin to guess — Brand.gatewayUrl is a
 * gateway root, which mounts the model routes but is not known to serve a course list.
 */
const noTenant = testEffect(apiLayer({ get: () => Effect.succeed({ type: "api", key: "jwt" } as never) }))

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
const strangeTenant = testEffect(
  apiLayer({
    get: () => Effect.succeed({ type: "api", key: "jwt", metadata: { baseUrl: "https://evil.example" } } as never),
  }),
)

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
const cacheFile = join(Global.Path.cache, `jolli-catalog-${Hash.fast(`${TENANT}||${TOKEN}`)}.json`)

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

const enrolled = testEffect(
  apiLayer({ get: () => Effect.succeed({ type: "api", key: TOKEN, metadata: { baseUrl: TENANT } } as never) }),
)

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
