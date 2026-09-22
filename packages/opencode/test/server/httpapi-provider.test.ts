import { describe, expect, test } from "bun:test"
import { isJolliConnected, JOLLI_PROVIDER_IDS, providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"
import { Brand } from "@opencode-ai/core/brand"
import { connectedProviderIds } from "../../src/server/routes/instance/httpapi/handlers/provider"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasNonZeroModelCost(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider) || !isRecord(provider.models)) return false
  return Object.values(provider.models).some((model) => {
    if (!isRecord(model) || !isRecord(model.cost) || !isRecord(model.cost.cache)) return false
    return [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write].some(
      (cost) => typeof cost === "number" && cost > 0,
    )
  })
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".jollicode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".jollicode", "plugin", "provider-oauth-parity.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-parity",',
        "  server: async () => ({",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderAuthValidationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".jollicode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".jollicode", "plugin", "provider-oauth-validation.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-validation",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "test-oauth-validation",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          prompts: [",
        "            {",
        '              type: "text",',
        '              key: "token",',
        '              message: "Token",',
        "              validate: (value) => value === 'ok' ? undefined : 'Token must be ok',",
        "            },",
        "          ],",
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeFunctionOptionsPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".jollicode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".jollicode", "plugin", "provider-function-options.ts"),
      [
        "export default {",
        '  id: "test.provider-function-options",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "google",',
        "      loader: async (_getAuth, provider) => {",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return {",
        '        apiKey: "",',
        "        fetch: async (input, init) => fetch(input, init),",
        "        }",
        "      },",
        "      methods: [{ type: 'api', label: 'API key' }],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderModelsMutationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".jollicode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".jollicode", "plugin", "provider-models-mutation.ts"),
      [
        "export default {",
        '  id: "test.provider-models-mutation",',
        "  server: async () => ({",
        "    provider: {",
        '      id: "google",',
        "      models: async (provider) => {",
        "        const models = Object.fromEntries(",
        "          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),",
        "        )",
        '        provider.name = "mutated-provider"',
        "        provider.options = { ...provider.options, mutatedByPlugin: true }",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return models",
        "      },",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-opencode-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "serves OAuth authorize response shapes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      // method 0 (api-key style) — authorize() resolves with no further
      // redirect; #26474 changed the wire format to JSON `null` so clients
      // can `.json()` parse uniformly instead of getting an empty body
      // that throws.
      expect(api).toEqual({ status: 200, body: "null" })

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(JSON.parse(oauth.body)).toEqual({
        url: oauthURL,
        method: "code",
        instructions: oauthInstructions,
      })
    }),
    { ...projectOptions, init: writeProviderAuthPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthValidationFailed",
        data: { field: "token", message: "Token must be ok" },
      })
    }),
    { ...projectOptions, init: writeProviderAuthValidationPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "serves provider lists when auth loaders add runtime fetch options",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "OPENCODE_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
      expect(hasNonZeroModelCost(configBody, "providers", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeFunctionOptionsPlugin },
  )

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeProviderModelsMutationPlugin },
  )

  /**
   * ⚠ A CREDENTIAL OUTLIVES EVERY PROVIDER BLOCK THAT WOULD CARRY IT, and this field still has to
   * report it. A provider whose models all resolved away is deleted from the list outright, so
   * reading `connected` off the surviving blocks alone answers "signed out" to somebody holding a
   * credential — which is how a signed-in Jolli student was sent back out to a browser sign-in on
   * every launch, storing the same credential again each time.
   */
  /**
   * ⚠ THE SIGNED-IN SIGNAL IS LIVE; THE MODEL LIST IS NOT. `connected` recomputes the credential on
   * every request, so a sign-in is visible immediately — which is why the desktop's
   * `isJolliSignedIn` can simply ask and does not depend on anything being invalidated first.
   *
   * ⚠ WHAT IS CACHED IS THE CONFIG-DERIVED PROVIDER BLOCK, and that is the only reason the sign-in
   * flow disposes the instance at all. This harness cannot observe that half: with no gateway to
   * fetch a catalogue from, the block has no models and is deleted either way. What it can pin is
   * that the route the flow calls exists and answers, and that the signal it relies on is live.
   */
  it.instance(
    "sees a credential that arrived after the server started, without being told to look again",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory }
      const connected = Effect.fn(function* () {
        const response = yield* request("/provider", { headers })
        return ((yield* response.json) as { connected: string[] }).connected
      })

      const jolli = providerIdFor("anthropic")
      expect(yield* connected()).not.toContain(jolli)

      yield* setEnvScoped("JOLLICODE_JOLLI_TOKEN", "injected-jwt")
      expect(yield* connected()).toContain(jolli)

      // The call the desktop sign-in makes before it hands control back to the renderer.
      const disposed = yield* request("/instance/dispose", { method: "POST", headers })
      expect(disposed.status).toBe(200)
      expect(yield* connected()).toContain(jolli)
    }),
    projectOptions,
  )

  /**
   * ⚠ AND IT NOTICES THE CREDENTIAL LEAVING, WHICH IS A SEPARATE CLAIM FROM THE ONE ABOVE. This
   * field is a union of what resolved and what is stored, and the first half is instance state:
   * resolved once, from a config built while the student was signed in, and still answering long
   * after the row behind it is gone. Two things remove one while the app runs — another surface
   * signing out of the shared store, and the backend refusing a renewal — and if a stale
   * resolution keeps voting, nothing downstream can ever see either of them. The composer goes on
   * offering models and the refusal arrives as a gateway 401.
   */
  it.instance(
    "stops reporting a credential once it is gone",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory }
      const connected = Effect.fn(function* () {
        const response = yield* request("/provider", { headers })
        return ((yield* response.json) as { connected: string[] }).connected
      })

      const jolli = providerIdFor("anthropic")
      yield* setEnvScoped("JOLLICODE_JOLLI_TOKEN", "injected-jwt")
      expect(yield* connected()).toContain(jolli)

      // Removed directly rather than through `setEnvScoped`, which only sets. The scope's own
      // release still restores whatever was there before this test ran.
      yield* Effect.sync(() => {
        delete process.env["JOLLICODE_JOLLI_TOKEN"]
      })
      expect(yield* connected()).not.toContain(jolli)
    }),
    projectOptions,
  )

  /**
   * ⚠ THE JOLLI CREDENTIAL IS NOT IN `auth.json`, SO THE CASE ABOVE DOES NOT COVER IT. It lives in
   * the shared database, and the union that answers this field had to learn about it separately —
   * silently, because the failure only appears when the gateway cannot be reached. A signed-in
   * student on a bad network resolves to a provider with no models, which is deleted outright; read
   * off the surviving blocks alone, `connected` then says "signed out" and `dialog-provider.tsx`
   * sends them back out to a browser sign-in on every launch.
   *
   * ⚠ THE CREDENTIAL ARRIVES THROUGH THE DEVELOPMENT OVERRIDE, which `jolli/session.ts` honours as
   * a synthetic row. That is the only lever a test in this harness has — and it exercises the same
   * read path the database takes.
   */
  it.instance(
    "counts a Jolli credential the database holds, even with no catalogue to resolve",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped("JOLLICODE_JOLLI_TOKEN", "injected-jwt")

      const response = yield* request("/provider", { headers: { "x-opencode-directory": directory } })
      expect(response.status).toBe(200)

      const body = (yield* response.json) as { connected: string[] }
      // Nothing to fetch a catalogue from, so no provider block survived to carry the credential.
      expect(providerByID(body, "all", Brand.short)).toBeUndefined()
      /**
       * ⚠ THE PROTOCOL IDS, NOT THE BARE AUTH ID. One credential backs all three providers the
       * config declares; `jolli` itself is where the sign-in is recorded and is not a provider
       * anything runs against, so it is not what this field reports.
       */
      expect(body.connected).toEqual(expect.arrayContaining(JOLLI_PROVIDER_IDS))
      expect(body.connected).not.toContain(Brand.short)
    }),
    projectOptions,
  )

  it.instance(
    "counts a held credential whose provider loaded no models",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped("OPENCODE_AUTH_CONTENT", JSON.stringify({ "never-loads": { type: "api", key: "jwt" } }))

      const response = yield* request("/provider", { headers: { "x-opencode-directory": directory } })
      expect(response.status).toBe(200)

      const body = (yield* response.json) as { connected: string[] }
      expect(providerByID(body, "all", "never-loads")).toBeUndefined()
      expect(body.connected).toContain("never-loads")
    }),
    projectOptions,
  )

  /**
   * ⚠ THE LEGACY `auth.json` ROW IS THE ONE CREDENTIAL THAT MUST NOT COUNT, WHICH INVERTS WHAT THIS
   * TEST ONCE ASSERTED. Every install that signed in before the credential moved to the shared
   * database still has a `jolli` entry in that file and nothing reads it any more — counting it
   * would report a student as connected who has no usable credential at all: the sign-in dialog
   * never offers to fix it and every message fails. The database is the only store, so it is the
   * only vote.
   */
  it.instance(
    "gives the legacy auth.json Jolli row no vote at all",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped("OPENCODE_AUTH_CONTENT", JSON.stringify({ jolli: { type: "api", key: "jwt" } }))

      const response = yield* request("/provider", { headers: { "x-opencode-directory": directory } })
      expect(response.status).toBe(200)

      const body = (yield* response.json) as { connected: string[] }
      expect(body.connected).not.toContain(Brand.short)
      for (const id of JOLLI_PROVIDER_IDS) expect(body.connected).not.toContain(id)
    }),
    {
      ...projectOptions,
      config: { ...projectOptions.config, enabled_providers: JOLLI_PROVIDER_IDS },
    },
  )
})

describe("connectedProviderIds", () => {
  const jolli = providerIdFor("anthropic")

  /**
   * ⚠ THE CASE THE INSTANCE-LEVEL TESTS ABOVE CANNOT REACH. They run without a catalogue, so a
   * Jolli provider never resolves there and the stale-resolution path is never taken — the filter
   * could be deleted and every one of them would still pass. This is the only place that pins it.
   */
  test("drops a resolved Jolli provider once the credential is gone", () => {
    expect(connectedProviderIds({ resolved: [jolli], stored: [], jolliCredential: false })).not.toContain(jolli)
  })

  test("keeps it while the credential is held", () => {
    expect(connectedProviderIds({ resolved: [jolli], stored: [], jolliCredential: true })).toContain(jolli)
  })

  /**
   * ⚠ EVERY OTHER PROVIDER IS READ FROM `auth.json` OR THE ENVIRONMENT ON THE SAME PASS, so there is
   * no separate store that could go out from under the resolution. Filtering them would report a
   * connected provider as disconnected.
   */
  test("never filters a provider that is not Jolli's", () => {
    expect(connectedProviderIds({ resolved: ["anthropic"], stored: [], jolliCredential: false })).toEqual([
      "anthropic",
    ])
  })

  /**
   * ⚠ THE OPPOSITE FAILURE, WHICH IS WHY THE UNION EXISTS AT ALL: a student whose catalogue could
   * not be fetched resolves no provider, and reporting them as signed out sends them back out to a
   * browser sign-in they do not need.
   */
  test("reports a held credential that resolved nothing", () => {
    expect(connectedProviderIds({ resolved: [], stored: [jolli], jolliCredential: true })).toEqual([jolli])
  })

  test("does not repeat an id that both halves name", () => {
    expect(connectedProviderIds({ resolved: [jolli], stored: [jolli], jolliCredential: true })).toEqual([jolli])
  })

  /**
   * ⚠ THE JOIN NOTHING ELSE PINNED, AND THREE CALL SITES SHIPPED BROKEN THROUGH THE GAP. The tests
   * above say what this answer CONTAINS and `jolli.test.ts` says what `isJolliConnected` ACCEPTS,
   * but nothing said the one satisfies the other — so `local.tsx`, `tips.tsx` and the desktop's
   * `isSignedIn` each asked for the bare `jolli` slug, each got `false` from a signed-in student,
   * and each had a green suite underneath it.
   *
   * ⚠ THE SECOND ASSERTION IS THE EXACT EXPRESSION THOSE THREE CALL SITES USED, kept beside the
   * first so the two readings of one answer sit in one place. It pins the contract, not the call
   * sites — nothing here can stop a fourth surface writing the slug again — but it is the sentence
   * whoever writes it next has to disagree with.
   */
  test("is an answer the UI's signed-in check accepts, and the bare slug never is", () => {
    const signedIn = connectedProviderIds({ resolved: [], stored: [...JOLLI_PROVIDER_IDS], jolliCredential: true })

    expect(isJolliConnected(signedIn)).toBe(true)
    expect(signedIn.includes(Brand.short)).toBe(false)
  })

  test("is an answer the UI's signed-in check rejects once the credential is gone", () => {
    expect(isJolliConnected(connectedProviderIds({ resolved: [jolli], stored: [], jolliCredential: false }))).toBe(
      false,
    )
  })
})
