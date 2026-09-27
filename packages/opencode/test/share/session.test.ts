import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionShare } from "@/share/session"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node])))

// Records every upstream share request; lockdown must leave this empty.
const calls: string[] = []
const recorder = HttpClient.make((req) => {
  calls.push(req.url)
  return Effect.die("unexpected http call")
})

const layer = (flags: Partial<RuntimeFlags.Info>) =>
  LayerNode.compile(SessionShare.node, [
    [httpClient, Layer.succeed(HttpClient.HttpClient, recorder)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

beforeEach(async () => {
  calls.length = 0
  process.env["JOLLICODE_LOCKDOWN"] = "1"
  await resetDatabase()
})

afterEach(() => {
  delete process.env["JOLLICODE_LOCKDOWN"]
})

describe("SessionShare under lockdown", () => {
  // create() uploads only through share(), so a refused share() after an auto-share create proves
  // no upload happened without waiting on the forked fiber.
  for (const share of ["auto", "manual"] as const) {
    it.live(`refuses to share when project config sets share: "${share}"`, () =>
      provideTmpdirInstance(
        () =>
          SessionShare.Service.use((svc) =>
            Effect.gen(function* () {
              const session = yield* svc.create()
              expect(session.share).toBeUndefined()
              const exit = yield* svc.share(session.id).pipe(Effect.exit)
              expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
                "Upstream sharing is not available",
              )
              expect(calls).toEqual([])
            }),
          ).pipe(Effect.provide(layer({ autoShare: share === "auto" }))),
        { git: true, config: { share } },
      ),
    )
  }
})
