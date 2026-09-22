import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config } from "@/config/config"
import { Auth } from "@/auth"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, FSUtil.node])))

function providerAuthLayer(directory: string, plugins: string[]) {
  return LayerNode.compile(ProviderAuth.node, [
    [
      Config.node,
      TestConfig.layer({
        get: () =>
          Effect.succeed({
            plugin: plugins,
            plugin_origins: plugins.map((plugin) => ({
              spec: plugin,
              source: path.join(directory, "opencode.json"),
              scope: "local" as const,
            })),
          }),
        directories: () => Effect.succeed([directory]),
      }),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer()],
  ])
}

describe("plugin.auth-override", () => {
  it.instance(
    "user plugin overrides built-in github-copilot auth",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".jollicode", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-copilot-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-copilot-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "github-copilot",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plain = yield* tmpdirScoped({ git: true })
        const plugin = pathToFileURL(path.join(pluginDir, "custom-copilot-auth.ts")).href
        const methods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(tmp.directory, [plugin])))
        const plainMethods = yield* ProviderAuth.use
          .methods()
          .pipe(Effect.provide(providerAuthLayer(plain, [])), provideInstance(plain))

        const copilot = methods[ProviderV2.ID.make("github-copilot")]
        expect(copilot).toBeDefined()
        expect(copilot.length).toBe(1)
        expect(copilot[0].label).toBe("Test Override Auth")
        expect(plainMethods[ProviderV2.ID.make("github-copilot")][0].label).not.toBe("Test Override Auth")
      }),
    { git: true },
    30000,
  )
})

describe("plugin.auth-managed", () => {
  it.instance(
    "a managed callback clears whatever auth.json still holds for that provider",
    () =>
      Effect.gen(function* () {
        /**
         * ⚠ `managed` IS A CLAIM ABOUT WHERE THE CREDENTIAL IS NOT, AND WRITING NOTHING DOES NOT
         * MAKE IT TRUE. Jolli's credential moved out of `auth.json` into the shared database, and
         * every install that signed in beforehand still has an entry here that nothing reads — a
         * bearer token with no owner, which `connected` also used to read as "signed in".
         */
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginFile = path.join(tmp.directory, ".opencode", "plugin", "managed-auth.ts")

        yield* fs.writeWithDirs(
          pluginFile,
          [
            "export default {",
            '  id: "demo.managed-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "demo-managed",',
            "      methods: [",
            "        {",
            '          type: "oauth",',
            '          label: "Sign in",',
            "          authorize: async () => ({",
            '            url: "https://example.com/oauth",',
            '            method: "auto",',
            "            callback: async () => ({ type: 'success', provider: 'demo-managed', managed: true }),",
            "          }),",
            "        },",
            "      ],",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const removed: string[] = []
        const layer = LayerNode.compile(ProviderAuth.node, [
          [
            Config.node,
            TestConfig.layer({
              get: () =>
                Effect.succeed({
                  plugin: [pathToFileURL(pluginFile).href],
                  plugin_origins: [
                    {
                      spec: pathToFileURL(pluginFile).href,
                      source: path.join(tmp.directory, "opencode.json"),
                      scope: "local" as const,
                    },
                  ],
                }),
              directories: () => Effect.succeed([tmp.directory]),
            }),
          ],
          [RuntimeFlags.node, RuntimeFlags.layer()],
          [
            Auth.node,
            Layer.mock(Auth.Service)({
              all: () => Effect.succeed({}),
              get: () => Effect.succeed({ type: "api" as const, key: "stale-from-before-the-move" }),
              set: () => Effect.void,
              remove: (key: string) => Effect.sync(() => void removed.push(key)),
            }),
          ],
        ])

        const providerID = ProviderV2.ID.make("demo-managed")
        yield* Effect.gen(function* () {
          const auth = yield* ProviderAuth.Service
          yield* auth.authorize({ providerID, method: 0 })
          yield* auth.callback({ providerID, method: 0 })
        }).pipe(Effect.provide(layer))

        expect(removed).toEqual(["demo-managed"])
      }),
    { git: true },
    30000,
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // Each hook's config call is wrapped in Effect.tryPromise with error logging + Effect.ignore
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
