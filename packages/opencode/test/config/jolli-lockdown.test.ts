import { afterEach, describe, expect, test } from "bun:test"
import { Brand } from "@opencode-ai/core/brand"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { providerIdFor, SUPPORTED_PROTOCOLS } from "@opencode-ai/core/jolli/gateway-config"
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
const enabledJolliProviders = SUPPORTED_PROTOCOLS.map(providerIdFor)

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
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
    // No credential, so no provider — declaring one here is what makes the app believe a
    // signed-out student is already connected.
    expect(config.provider).toBeUndefined()
  })

  test("keeps provider blocks empty when the signed-in catalogue is unavailable", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const config = await loadConfig(signedIn)
    expect(config.enabled_providers).toEqual(enabledJolliProviders)
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
    const config = await loadConfig(otherProviderOnly)
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
