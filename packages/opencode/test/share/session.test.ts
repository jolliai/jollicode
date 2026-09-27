import { beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
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

const lockedDown = (flags: Partial<RuntimeFlags.Info>) =>
  LayerNode.compile(SessionShare.node, [
    [httpClient, Layer.succeed(HttpClient.HttpClient, recorder)],
    [RuntimeFlags.node, RuntimeFlags.layer({ lockdown: true, ...flags })],
  ])

beforeEach(async () => {
  calls.length = 0
  await resetDatabase()
})

describe("SessionShare under lockdown", () => {
  it.live("does not auto-share even when project config asks for it", () =>
    provideTmpdirInstance(
      () =>
        SessionShare.Service.use((svc) =>
          Effect.gen(function* () {
            const session = yield* svc.create()
            // Auto-share is forked, so give it the chance to reach the network before asserting.
            yield* Effect.sleep("200 millis")
            expect(session.share).toBeUndefined()
            expect(calls).toEqual([])
          }),
        ).pipe(Effect.provide(lockedDown({ autoShare: true }))),
      { git: true, config: { share: "auto" } },
    ),
  )

  it.live("refuses an explicit share even when project config allows it", () =>
    provideTmpdirInstance(
      () =>
        SessionShare.Service.use((svc) =>
          Effect.gen(function* () {
            const session = yield* svc.create()
            expect(Exit.isFailure(yield* svc.share(session.id).pipe(Effect.exit))).toBe(true)
            expect(calls).toEqual([])
          }),
        ).pipe(Effect.provide(lockedDown({}))),
      { git: true, config: { share: "manual" } },
    ),
  )
})
