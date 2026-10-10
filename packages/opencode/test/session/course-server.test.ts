import { describe, expect } from "bun:test"
import { JOLLI_MCP_SERVER } from "@opencode-ai/core/jolli/mcp"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"
import { InstanceRef } from "../../src/effect/instance-ref"
import { MCP } from "../../src/mcp"
import type { InstanceContext } from "../../src/project/instance-context"
import { CourseServer } from "../../src/session/course-server"
import { testEffect } from "../lib/effect"

// The course server as the fake MCP layer reports it, every reconnect asked of it, and what a
// reconnect does; reset by each test.
const server = {
  status: undefined as MCP.Status | undefined,
  connects: 0,
  connect: (): Effect.Effect<void> => Effect.void,
}

function reset(status: MCP.Status | undefined, connect: () => Effect.Effect<void>) {
  server.status = status
  server.connects = 0
  server.connect = connect
}

const connectsAtOnce = () =>
  Effect.sync(() => {
    server.status = { status: "connected" }
  })

const unexpected = () => Effect.die("unexpected MCP call in course server tests")

const it = testEffect(
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () =>
        Effect.sync((): Record<string, MCP.Status> => (server.status ? { [JOLLI_MCP_SERVER]: server.status } : {})),
      connect: () =>
        Effect.suspend(() => {
          server.connects++
          return server.connect()
        }),
      clients: unexpected,
      instructions: unexpected,
      tools: unexpected,
      prompts: unexpected,
      resources: unexpected,
      resourceTemplates: unexpected,
      add: unexpected,
      disconnect: unexpected,
      getPrompt: unexpected,
      readResource: unexpected,
      startAuth: unexpected,
      authenticate: unexpected,
      finishAuth: unexpected,
      removeAuth: unexpected,
      supportsOAuth: unexpected,
      hasStoredTokens: unexpected,
      getAuthStatus: unexpected,
    }),
  ),
)

// Attempts are remembered per instance directory, so each test runs in a directory of its own.
let instances = 0
function inInstance<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const context = { directory: `/course-server-test-${++instances}`, worktree: "/" } as unknown as InstanceContext
  return effect.pipe(Effect.provideService(InstanceRef, context))
}

describe("CourseServer.ensure", () => {
  it.effect("reconnects a failed course server and waits for it", () =>
    Effect.gen(function* () {
      reset({ status: "failed", error: "fetch failed" }, connectsAtOnce)

      yield* CourseServer.ensure(yield* Scope.Scope).pipe(inInstance)

      expect(server.connects).toBe(1)
      expect(server.status).toEqual({ status: "connected" })
    }),
  )

  it.effect("leaves a connected, switched-off or unconfigured server alone", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      for (const status of [{ status: "connected" as const }, { status: "disabled" as const }, undefined]) {
        reset(status, connectsAtOnce)
        yield* CourseServer.ensure(scope).pipe(inInstance)
        expect(server.connects).toBe(0)
      }
    }),
  )

  it.effect("asks a server that stays down again only after the retry interval", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      reset({ status: "failed", error: "fetch failed" }, () => Effect.void)

      yield* Effect.gen(function* () {
        yield* CourseServer.ensure(scope)
        yield* CourseServer.ensure(scope)
        expect(server.connects).toBe(1)

        yield* TestClock.adjust(CourseServer.RETRY_INTERVAL)
        yield* CourseServer.ensure(scope)
        expect(server.connects).toBe(2)
      }).pipe(inInstance)
    }),
  )

  it.effect("stops waiting for a slow attempt, which a later message joins rather than repeats", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const gate = yield* Deferred.make<void>()
      reset({ status: "failed", error: "fetch failed" }, () =>
        Deferred.await(gate).pipe(Effect.andThen(connectsAtOnce)),
      )

      yield* Effect.gen(function* () {
        const first = yield* CourseServer.ensure(scope).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(CourseServer.WAIT)
        yield* Fiber.join(first)
        // The message went on without the server, and the attempt is still running.
        expect(server.status?.status).toBe("failed")

        const second = yield* CourseServer.ensure(scope).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(second)
        expect(server.connects).toBe(1)
        expect(server.status).toEqual({ status: "connected" })
      }).pipe(inInstance)
    }),
  )
})
