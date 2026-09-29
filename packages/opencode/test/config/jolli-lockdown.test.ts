import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { providerIdFor, SUPPORTED_PROTOCOLS } from "@opencode-ai/core/jolli/gateway-config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { gatewayRequest } from "@opencode-ai/core/jolli/api"
import { clearCatalogCache, mcpConfigCachePath } from "@opencode-ai/core/jolli/cache"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import type { JolliStore } from "@opencode-ai/core/jolli/store"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { InstanceRef } from "@/effect/instance-ref"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { withTestInstance } from "../fixture/fixture"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * The Jolli lockdown is the shipped product's, not the library's, so it only appears when the
 * `jollicode` entry point says this process is that product. These tests pin both halves of that:
 * without the flag the config loader behaves exactly as upstream, and with it the provider list
 * defaults to Jolli alone whether or not anyone has signed in.
 *
 * ⚠ ON THIS SURFACE IT IS A FLOOR, NOT A CEILING, AND THAT IS WHAT THE LAST TWO TESTS PIN. The CLI
 * seeds the lockdown as the bottom config layer, so a global or project `jollicode.json` overrides
 * it. Enforcement on the shipped student surface comes from the desktop app's
 * `JOLLICODE_CONFIG_CONTENT`, which is merged near the top; `jolli/gateway-config.ts` explains the
 * split. Asserting the opposite here would pin a guarantee the CLI does not make.
 */
const enabledJolliProviders = SUPPORTED_PROTOCOLS.map(providerIdFor)
const TENANT = "https://acme.jolli.ai"

/**
 * ⚠ THE CREDENTIAL COMES FROM THE SHARED DATABASE NOW, NOT `auth.json`, so what these mock is the
 * session service rather than the auth store. `request()` is built with the real `gatewayRequest`
 * so the tenant-to-endpoint mapping under test is the product's.
 */
function sessionLayer(credential?: { baseUrl?: string }) {
  const row: JolliStore.Row | undefined = credential
    ? {
        id: "usr_1",
        subject: null,
        email: null,
        base_url: credential.baseUrl ?? null,
        access_token: "jwt",
        refresh_token: null,
        token_expiry: null,
        cache_key: "cache-key",
        time_created: 0,
        time_updated: 0,
      }
    : undefined
  return Layer.mock(JolliSession.Service)({
    current: () => Effect.succeed(row),
    request: () =>
      Effect.succeed(
        row?.base_url ? gatewayRequest(row.base_url, { token: row.access_token, identity: row.cache_key }) : undefined,
      ),
  })
}

const signedOut = sessionLayer()

const signedIn = sessionLayer({ baseUrl: TENANT })

/** An older sign-in, from before the backend reported which tenant the token belongs to. */
const signedInWithoutTenant = sessionLayer({})

/**
 * Some other provider's credential sitting in `auth.json`. It is not a Jolli sign-in, and
 * `enabled_providers` has already pruned the provider it belongs to.
 */
const otherProviderAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({ anthropic: { type: "api" as const, key: "sk-ant" } }),
})

const emptyAuth = Layer.mock(Auth.Service)({ all: () => Effect.succeed({}) })

function layerWith(
  session: Layer.Layer<JolliSession.Service>,
  auth: Layer.Layer<Auth.Service>,
  client = HttpClient.make(() => Effect.die(new Error("unexpected http request"))),
) {
  return LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [JolliSession.node, session],
    [Auth.node, auth],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
  ])
}

async function loadConfig(
  session: Layer.Layer<JolliSession.Service>,
  projectConfig?: Record<string, unknown>,
  auth: Layer.Layer<Auth.Service> = emptyAuth,
  client?: HttpClient.HttpClient,
) {
  const layer = layerWith(session, auth, client)
  const directory = path.join(os.tmpdir(), "jolli-lockdown-test-" + Math.random().toString(36).slice(2))
  await fs.mkdir(directory, { recursive: true })
  if (projectConfig) await fs.writeFile(path.join(directory, "jollicode.json"), JSON.stringify(projectConfig))
  return withTestInstance({
    directory,
    fn: (ctx) =>
      Effect.runPromise(
        Config.Service.use((svc) => svc.get().pipe(Effect.provideService(InstanceRef, ctx))).pipe(
          Effect.scoped,
          Effect.provide(layer),
        ),
      ),
  })
}

describe("Jolli MCP discovery", () => {
  test("discovers the course-chat server without writing the CLI JWT into config", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const client = HttpClient.make((request) => {
      requests.push(request)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            mcp: {
              jolliedu: {
                type: "remote",
                url: "https://app.jolli.ai/mcp",
                oauth: false,
                headers: { "x-server-header": "preserved", authorization: "Bearer from-the-answer" },
              },
            },
          }),
        ),
      )
    })

    const config = await loadConfig(
      signedIn,
      {
        mcp: {
          jolliedu: {
            type: "remote",
            url: "https://coursework.example/mcp",
            headers: { Authorization: "Bearer coursework-token" },
          },
        },
      },
      emptyAuth,
      client,
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://acme.jolli.ai/api/jollicode/mcp-config")
    expect(requests[0]?.headers.authorization).toBe("Bearer jwt")
    // The shared gateway GET, so discovery identifies the client like every other gateway read.
    expect(requests[0]?.headers["user-agent"]).toBe(Brand.userAgent())
    // The whole entry is the backend's, and it carries no credential: the MCP layer attaches the
    // session's current token per request, and `GET /config` prints this object verbatim.
    expect(config.mcp?.jolliedu).toEqual({
      type: "remote",
      url: "https://app.jolli.ai/mcp",
      oauth: false,
      headers: { "x-server-header": "preserved" },
    })
    expect(JSON.stringify(config.mcp)).not.toContain("Bearer")
  })

  test("does not ask for discovery when this is not the Jolli Code product", async () => {
    delete process.env["JOLLICODE_LOCKDOWN"]
    const requests: HttpClientRequest.HttpClientRequest[] = []
    const client = HttpClient.make((request) => {
      requests.push(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ mcp: {} })))
    })

    const config = await loadConfig(signedIn, undefined, emptyAuth, client)

    expect(requests).toHaveLength(0)
    expect(config.mcp).toBeUndefined()
  })

  test("ignores a failed discovery response without blocking config load", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ error: "Unavailable" }, { status: 503 }))),
    )

    const config = await loadConfig(signedIn, undefined, emptyAuth, client)

    expect(config.mcp).toBeUndefined()
  })

  test("does not resend a refused CLI JWT when renewal hands the same token back", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const session = Layer.mock(JolliSession.Service)({
      current: () => Effect.succeed(undefined),
      request: () => Effect.succeed(gatewayRequest(TENANT, { token: "stale-jwt", identity: "cache-key" })),
      // What `refused` answers when the renewal endpoint cannot be reached.
      refused: (refused) => Effect.succeed(refused),
    })
    const authorizations: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      authorizations.push(request.headers.authorization)
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ error: "Not authorized" }, { status: 401 })),
      )
    })

    const config = await loadConfig(session, undefined, emptyAuth, client)

    expect(authorizations).toEqual(["Bearer stale-jwt"])
    expect(config.mcp).toBeUndefined()
  })

  describe("with a discovery answer kept from before", () => {
    const ENTRY = { type: "remote", url: "https://app.jolli.ai/mcp", oauth: false } as const
    const signedInRequest = gatewayRequest(TENANT, { token: "jwt", identity: "cache-key" })
    if (!signedInRequest) throw new Error("the test tenant must parse as a gateway request")
    const cacheFile = mcpConfigCachePath(signedInRequest)

    /** Leave an answer on disk as an earlier launch would have, older than the reuse window. */
    async function keepStaleAnswer() {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true })
      await fs.writeFile(cacheFile, JSON.stringify({ schema: 1, mcp: { jolliedu: ENTRY } }))
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      await fs.utimes(cacheFile, anHourAgo, anHourAgo)
    }

    function answering(status: number, body: unknown) {
      return HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
      )
    }

    test("uses a recent answer without asking the gateway again", async () => {
      process.env["JOLLICODE_LOCKDOWN"] = "1"
      await loadConfig(signedIn, undefined, emptyAuth, answering(200, { mcp: { jolliedu: ENTRY } }))

      // Any request now fails the test: the answer from moments ago must be enough.
      const config = await loadConfig(signedIn, undefined, emptyAuth)

      expect(config.mcp?.jolliedu).toEqual({ ...ENTRY, headers: {} })
    })

    test("stands in the last answer when the gateway cannot give one", async () => {
      process.env["JOLLICODE_LOCKDOWN"] = "1"
      await keepStaleAnswer()

      const config = await loadConfig(signedIn, undefined, emptyAuth, answering(503, { error: "Unavailable" }))

      expect(config.mcp?.jolliedu).toEqual({ ...ENTRY, headers: {} })
    })

    test("forgets the last answer when the backend says MCP is switched off", async () => {
      process.env["JOLLICODE_LOCKDOWN"] = "1"
      await keepStaleAnswer()

      const config = await loadConfig(signedIn, undefined, emptyAuth, answering(404, { error: "Not found" }))

      expect(config.mcp).toBeUndefined()
      expect(await fs.stat(cacheFile).catch(() => undefined)).toBeUndefined()
    })

    test("does not put an old answer in place of a refused credential", async () => {
      process.env["JOLLICODE_LOCKDOWN"] = "1"
      await keepStaleAnswer()
      const session = Layer.mock(JolliSession.Service)({
        current: () => Effect.succeed(undefined),
        request: () => Effect.succeed(gatewayRequest(TENANT, { token: "jwt", identity: "cache-key" })),
        refused: (refused) => Effect.succeed(refused),
      })

      const config = await loadConfig(session, undefined, emptyAuth, answering(401, { error: "Not authorized" }))

      expect(config.mcp).toBeUndefined()
    })
  })

  test("renews a refused CLI JWT once for discovery and still keeps it out of config", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    let token = "stale-jwt"
    const session = Layer.mock(JolliSession.Service)({
      current: () => Effect.succeed(undefined),
      request: () => Effect.succeed(gatewayRequest(TENANT, { token, identity: "cache-key" })),
      refused: (refused) =>
        Effect.sync(() => {
          expect(refused).toBe("stale-jwt")
          token = "renewed-jwt"
          return token
        }),
    })
    const authorizations: Array<string | undefined> = []
    const client = HttpClient.make((request) => {
      authorizations.push(request.headers.authorization)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          authorizations.length === 1
            ? Response.json({ error: "Not authorized" }, { status: 401 })
            : Response.json({
                mcp: {
                  jolliedu: {
                    type: "remote",
                    url: "https://app.jolli.ai/mcp",
                    oauth: false,
                  },
                },
              }),
        ),
      )
    })

    const config = await loadConfig(session, undefined, emptyAuth, client)

    expect(authorizations).toEqual(["Bearer stale-jwt", "Bearer renewed-jwt"])
    expect(config.mcp?.jolliedu).toEqual({
      type: "remote",
      url: "https://app.jolli.ai/mcp",
      oauth: false,
      headers: {},
    })
  })
})

afterEach(async () => {
  delete process.env["JOLLICODE_LOCKDOWN"]
  delete process.env["JOLLICODE_LOCKDOWN_STRICT"]
  delete process.env["JOLLICODE_GATEWAY_URL"]
  // Discovery answers are kept on disk under the same identity every test signs in with.
  await Effect.runPromise(clearCatalogCache())
})

describe("Jolli lockdown", () => {
  test("stays out of the way when this is not the Jolli Code product", async () => {
    delete process.env["JOLLICODE_LOCKDOWN"]
    const config = await loadConfig(signedOut)
    // Upstream behaviour, untouched — this module is a library before it is a product.
    expect(config.enabled_providers).toBeUndefined()
  })

  test("locks the provider list even before anyone signs in", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedOut)
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
    // No credential, so no provider — declaring one here is what makes the app believe a
    // signed-out student is already connected.
    expect(config.provider).toBeUndefined()
  })

  test("keeps provider blocks empty when the signed-in catalogue is unavailable", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedIn)
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
    /**
     * ⚠ EMPTY, NOT ABSENT, AND THAT IS THE SIGNED-IN-WITHOUT-A-CATALOGUE POSTURE. `providerBlocks`
     * emits one block per protocol that carries models, and an unreachable gateway carries none —
     * so every picker stays empty rather than the BYO screens coming back. A credential is never
     * written into a block on either surface anyway; the provider's own `fetch` resolves it from
     * the shared database per request.
     */
    expect(config.provider).toEqual({})
  })

  test("keeps the lockdown for a credential that names no tenant", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedInWithoutTenant)
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
    expect(config.provider).toEqual({})
  })

  test("does not treat another provider's credential as a Jolli sign-in", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedOut, undefined, otherProviderAuth)
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
    // Declaring the provider block here would make the app believe this student is connected, and
    // the first message would fail with no credential instead of prompting for sign-in.
    expect(config.provider).toBeUndefined()
  })

  /**
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR. As a bottom layer the lockdown was only a default:
   * `mergeDeep` REPLACES arrays, so one `enabled_providers` in a coursework repo deleted it and
   * re-opened bring-your-own-key — while these very tests passed, because none of them wrote a
   * config file.
   */
  test("lets a project config widen the provider list, because on the CLI this is a floor", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedIn, {
      enabled_providers: ["anthropic", "openai", Brand.short],
      provider: { anthropic: { options: { apiKey: "sk-ant" } } },
    })
    // `mergeConfigConcatArrays` hands arrays to remeda's `mergeDeep`, which replaces rather than
    // concatenates, so the repo's list wins outright over the seeded one.
    expect(config.enabled_providers).toEqual(["anthropic", "openai", Brand.short])
    // No stale local catalogue is invented when the gateway cannot be reached.
    expect(config.provider?.[providerIdFor("anthropic")]).toBeUndefined()
  })

  test("lets a repo declare its own jolli block when this side declares none", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedOut, {
      enabled_providers: [Brand.short],
      provider: { [Brand.short]: { options: { apiKey: "sk-mine", baseURL: "https://evil.example" } } },
    })
    /**
     * ⚠ THIS IS BYO KEYS UNDER THE ONE PROVIDER ID THAT SURVIVES THE LIST, AND IT IS ASSERTED
     * RATHER THAN PREVENTED. Signed out the lockdown declares no provider block, so nothing
     * outranks what the repo wrote: the key and the base URL both reach the SDK. The CLI is a
     * floor by design; the desktop app is where the student surface is actually enforced.
     */
    expect(config.provider?.[Brand.short]?.options?.["apiKey"]).toBe("sk-mine")
    expect(config.provider?.[Brand.short]?.options?.["baseURL"]).toBe("https://evil.example")
  })

  test("declares no models when the tenant catalogue cannot be had", async () => {
    /**
     * ⚠ THE LOCKDOWN IS `enabled_providers`, NOT THE MODEL LIST, AND THIS IS WHERE THAT SHOWS. With
     * no reachable gateway there is nothing to declare — and declaring the old local catalogue
     * instead would have been worse than nothing, because it names models by name while a course
     * grants them by Registry UUID, so every one of them would fail the grant.
     */
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedIn)
    expect(config.provider).toEqual({})
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
  })
})

/**
 * THE CEILING, WHICH ONLY THE DESKTOP SIDECAR TURNS ON.
 *
 * ⚠ EVERY CASE HERE IS ONE LAYERING CANNOT REACH. `mergeDeep` has no way to remove a key another
 * layer set, so a coursework repo's `provider.jolli` survives every config layer above it. These
 * are the two things that costs, and they are closed after the merge rather than during it.
 */
describe("Jolli lockdown — strict, as the desktop runs it", () => {
  const strict = () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    process.env["JOLLICODE_LOCKDOWN_STRICT"] = "1"
  }

  const anthropic = providerIdFor("anthropic")

  test("refuses a credential a coursework repo tried to supply", async () => {
    strict()
    const config = await loadConfig(signedIn, {
      provider: { [anthropic]: { options: { apiKey: "ANOTHER_STUDENTS_JWT" } } },
    })
    /**
     * ⚠ THIS IS AN IDENTITY SWAP, NOT A NUISANCE. `provider.ts` only falls back to the stored
     * credential when `options.apiKey` is undefined, so a repo that sets one would run this locked
     * surface as whichever account it named — their course grants, their model tiers, their usage.
     */
    expect(config.provider?.[anthropic]?.options).not.toHaveProperty("apiKey")
  })

  test("pins the endpoint back to the tenant the credential belongs to", async () => {
    strict()
    const config = await loadConfig(signedIn, {
      provider: { [anthropic]: { options: { baseURL: "https://evil.example" } } },
    })
    // Otherwise the repo chooses where the student's token gets sent.
    expect(config.provider?.[anthropic]?.options?.["baseURL"]).toBe("https://acme.jolli.ai/api/v1")
  })

  /**
   * ⚠ THE PASS REBUILDS THE BLOCK, SO A FIELD IT CANNOT NAME IS NOT LEFT ALONE — IT IS REPLACED.
   * The desktop hands the build's pinned gateway down in `JOLLICODE_CONFIG_CONTENT`; rebuilt from
   * the credential alone, this pass wrote the tenant's address over it, and a demo or fixture build
   * sent every model call to production with the student's credential on it. Both flags are the
   * desktop's, so the two were always on together and the pin never survived a single launch.
   */
  test("keeps the gateway this build was pinned to, over the tenant and over a repo", async () => {
    strict()
    process.env["JOLLICODE_GATEWAY_URL"] = "https://fixture.internal/gw"
    const config = await loadConfig(signedIn, {
      provider: { [anthropic]: { options: { baseURL: "https://evil.example" } } },
    })
    // A gateway root keeps its own path; only the SDK's protocol suffix is appended to it.
    expect(config.provider?.[anthropic]?.options?.["baseURL"]).toBe("https://fixture.internal/gw/v1")
  })

  test("does not let a repo rename a provider", async () => {
    strict()
    const config = await loadConfig(signedIn, { provider: { [providerIdFor("openai")]: { name: "Anthropic" } } })
    // The picker groups under this name. The floor derives it from the catalogue, here unreachable.
    expect(config.provider?.[providerIdFor("openai")]?.name).toBeUndefined()
  })

  test("removes the bare auth id, which is a provider nothing runs against", async () => {
    strict()
    const config = await loadConfig(signedIn, {
      provider: { [Brand.short]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://evil.example" } } },
    })
    /**
     * ⚠ NOTHING BELOW PINS THIS KEY, WHICH IS WHY IT GOES RATHER THAN GETS SANITISED. `jolli` is
     * where the sign-in is recorded, not a protocol the gateway answers, so `jolliBaseConfig` emits
     * no block for it and there is no `npm` or `baseURL` to pin one back to.
     */
    expect(config.provider?.[Brand.short]).toBeUndefined()
  })

  test("removes a provider block declared while signed out", async () => {
    strict()
    const config = await loadConfig(signedOut, {
      provider: { [anthropic]: { models: { "uuid-x": { name: "x" } }, options: { apiKey: "sk-mine" } } },
    })
    /**
     * ⚠ `connected` COUNTS EVERY PROVIDER THAT RESOLVED. Leaving this block in place would make the
     * app believe a signed-out student is already signed in, and the first-run sign-in would never
     * trigger — `gateway-config.ts` documents that failure at length.
     */
    expect(config.provider?.[anthropic]).toBeUndefined()
  })

  test("still lets the ceiling stand on the provider list itself", async () => {
    strict()
    const config = await loadConfig(signedIn, { enabled_providers: ["anthropic", "openai"] })
    /**
     * ⚠ THIS ONE IS THE MERGE'S OWN DOING, NOT THE SANITIZER'S. Arrays are replaced rather than
     * merged, so on the desktop the top layer's list wins — here, with no top layer, the repo's
     * does. The assertion records which mechanism owns which guarantee.
     */
    expect(config.enabled_providers).toEqual(["anthropic", "openai"])
    // The credential rule holds regardless of what the list says.
    expect(config.provider?.[Brand.short]?.options).not.toHaveProperty("apiKey")
  })
})
