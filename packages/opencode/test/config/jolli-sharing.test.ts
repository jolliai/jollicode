import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Brand } from "@opencode-ai/core/brand"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { Env } from "@/env"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { withTestInstance } from "../fixture/fixture"

/**
 * THE POINT OF THE WHOLE CHANGE, ASSERTED END TO END.
 *
 * ⚠ SIGNING IN ON ONE SURFACE USED TO LEAVE THE OTHER SIGNED OUT, and nothing caught it because
 * neither surface's tests ever looked at the other's store. The desktop kept its token in the OS
 * keychain and the bare CLI kept its own in `auth.json`; there was no file both of them read.
 *
 * ⚠ SO THIS BUILDS THE SERVICE GRAPH TWICE OVER ONE DATABASE FILE — one graph standing in for the
 * sidecar that signs the student in, the other for the bare CLI that must then already know. Two
 * separate `Layer` builds is as close as a single test process gets to two processes, and it is the
 * property that actually matters: nothing about the credential is held in memory across them.
 *
 * ⚠ ONE HALF OF THE GUARANTEE IS NOT TESTED HERE AND CANNOT BE, WHICH IS WORTH KNOWING. These pass
 * a file in explicitly; the shipped app relies on `Database.path()` resolving to the SAME file in
 * both processes, and that resolution is a build-time question — `InstallationChannel` reads a bare
 * global that `packages/desktop/electron.vite.config.ts` defines for the sidecar bundle and not for
 * the Electron main bundle. This suite cannot see it either way, because it forces the database to
 * `:memory:` through `JOLLICODE_DB` before core is even imported (`Flag.OPENCODE_DB` is read once,
 * at module load, so a test cannot lift it). It is the reason the main process asks the sidecar
 * rather than opening the database itself — see `packages/desktop/src/main/jolli-sidecar.ts`.
 */
const TENANT = "https://acme.jolli.ai"

const files: string[] = []
async function databaseFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jolli-sharing-"))
  files.push(dir)
  return path.join(dir, "jollicode.db")
}

afterEach(async () => {
  delete process.env["JOLLICODE_LOCKDOWN"]
  await Promise.all(files.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

/** The surface that signs in: nothing but the credential store and its refresh machinery. */
const signInOn = (file: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* JolliSession.Service
      yield* session.signIn({ token: "access-1", refreshToken: "refresh-1", baseUrl: TENANT, subject: "usr_1" })
    }).pipe(
      Effect.provide(LayerNode.compile(JolliSession.node, [[Database.node, Database.layerFromPath(file)]])),
      Effect.scoped,
    ),
  )

/** The other surface: a full config load, with no environment and no `auth.json` to help it. */
async function loadConfigOn(file: string) {
  const layer = LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Database.node, Database.layerFromPath(file)],
    [Auth.node, Layer.mock(Auth.Service)({ all: () => Effect.succeed({}) })],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        // The catalogue fetch is supposed to fail here: what is under test is the credential, and
        // `jolliLockdownConfig` already swallows an unreachable gateway into an empty model list.
        HttpClient.make(() => Effect.die(new Error("unexpected http request"))),
      ),
    ],
  ])
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jolli-sharing-cwd-"))
  files.push(directory)
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

describe("one credential, both surfaces", () => {
  test("a sign-in on one surface is already a sign-in on the other", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const file = await databaseFile()

    await signInOn(file)
    const config = await loadConfigOn(file)

    /**
     * ⚠ EMPTY, NOT ABSENT, AND THAT DISTINCTION IS THE WHOLE SIGNAL HERE. The catalogue fetch is
     * rigged to fail, so there are no models to group and therefore no protocol blocks — but a
     * signed-in load still emits the `provider` key, and a signed-out one (the test below) emits
     * nothing at all. No `JOLLICODE_CONFIG_CONTENT`, no `auth.json`, no shared memory: only the
     * file carries the sign-in from one surface to the other.
     */
    expect(config.provider).toEqual({})
  })

  test("and signing out on one is a sign-out on the other", async () => {
    process.env["JOLLICODE_LOCKDOWN"] = "1"
    const file = await databaseFile()

    await signInOn(file)
    await Effect.runPromise(
      JolliSession.Service.use((session) => session.signOut()).pipe(
        Effect.provide(LayerNode.compile(JolliSession.node, [[Database.node, Database.layerFromPath(file)]])),
        Effect.scoped,
      ),
    )

    // Declaring a provider block here is what makes a signed-out student look connected.
    expect((await loadConfigOn(file)).provider).toBeUndefined()
  })
})
