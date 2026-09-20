import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { MODEL_CATALOG } from "@opencode-ai/core/jolli/model-catalog"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
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
 * seeds the lockdown as the bottom config layer, so a global or project `opencode.json` overrides
 * it. Enforcement on the shipped student surface comes from the desktop app's
 * `JOLLICODE_CONFIG_CONTENT`, which is merged near the top; `jolli/gateway-config.ts` explains the
 * split. Asserting the opposite here would pin a guarantee the CLI does not make.
 */
const signedOut = Layer.mock(Auth.Service)({ all: () => Effect.succeed({}) })

const signedIn = Layer.mock(Auth.Service)({
  all: () =>
    Effect.succeed({
      [Brand.short]: { type: "api" as const, key: "jwt", metadata: { baseUrl: "https://acme.jolli.ai" } },
    }),
})

/** An older sign-in, from before the backend reported which tenant the token belongs to. */
const signedInWithoutTenant = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({ [Brand.short]: { type: "api" as const, key: "jwt" } }),
})

/**
 * Some other provider's credential sitting in the same `auth.json`. It is not a Jolli sign-in, and
 * `enabled_providers` has already pruned the provider it belongs to.
 */
const otherProviderOnly = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({ anthropic: { type: "api" as const, key: "sk-ant" } }),
})

function layerWith(auth: Layer.Layer<Auth.Service>) {
  return LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, auth],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die(new Error("unexpected http request"))),
      ),
    ],
  ])
}

async function loadConfig(auth: Layer.Layer<Auth.Service>, projectConfig?: Record<string, unknown>) {
  const layer = layerWith(auth)
  const directory = path.join(os.tmpdir(), "jolli-lockdown-test-" + Math.random().toString(36).slice(2))
  await fs.mkdir(directory, { recursive: true })
  if (projectConfig) await fs.writeFile(path.join(directory, "opencode.json"), JSON.stringify(projectConfig))
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

afterEach(() => {
  delete process.env["JOLLICODE_LOCKDOWN"]
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
    expect(config.enabled_providers).toEqual([Brand.short])
    // No credential, so no provider — declaring one here is what makes the app believe a
    // signed-out student is already connected.
    expect(config.provider?.[Brand.short]).toBeUndefined()
  })

  test("declares the provider once a credential exists, pointed at that tenant", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedIn)
    expect(config.enabled_providers).toEqual([Brand.short])
    expect(config.provider?.[Brand.short]?.options?.["baseURL"]).toBe("https://acme.jolli.ai/api")
    // The JWT lives in auth.json; the provider resolver fills it in from there.
    expect(config.provider?.[Brand.short]?.options?.["apiKey"]).toBeUndefined()
  })

  test("falls back to the brand gateway for a credential that names no tenant", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedInWithoutTenant)
    // Signed in is signed in: a backend that predates `baseUrl` must still reach a gateway. Used
    // verbatim — `api.jolli.ai` is the gateway host, not a tenant with the gateway under `/api`.
    expect(config.provider?.[Brand.short]?.options?.["baseURL"]).toBe(Brand.gatewayUrl)
  })

  test("does not treat another provider's credential as a Jolli sign-in", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(otherProviderOnly)
    expect(config.enabled_providers).toEqual([Brand.short])
    // Declaring the provider block here would make the app believe this student is connected, and
    // the first message would fail with no credential instead of prompting for sign-in.
    expect(config.provider?.[Brand.short]).toBeUndefined()
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
    // The seeded Jolli block is still there underneath, so a signed-in student keeps a working
    // gateway even while the repo has widened the list around it.
    expect(config.provider?.[Brand.short]?.options?.["baseURL"]).toBe("https://acme.jolli.ai/api")
  })

  test("lets a repo declare its own jolli block when this side declares none", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedOut, {
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

  test("declares the catalogue the student may run, keyed by the id the UI names", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedIn)
    const models = config.provider?.[Brand.short]?.models ?? {}
    expect(Object.keys(models)).toEqual(MODEL_CATALOG.map((model) => model.id))
    // No route on this surface, so the catalogue id is what goes upstream (the desktop sidecar is
    // the one that rewrites them, in `jolli-gateway.ts`).
    expect(Object.values(models).every((model) => model?.id === undefined)).toBe(true)
  })
})
