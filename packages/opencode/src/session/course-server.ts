/**
 * THE SERVER A BOUND SESSION'S COURSE TOOLS COME FROM, RECONNECTED WHEN IT FAILED.
 *
 * The jolliedu MCP server is connected once, when the instance boots, and nothing in the MCP layer
 * tries a failed server again. A backend that was still starting, a dropped connection or a passing
 * network fault therefore cost every bound session in the directory its course tools for as long as
 * the instance lived, and under `restrictToMaterials` that is every knowledge answer. So each message
 * of a bound session checks the server first ({@link ensure}), and reconnects it when it failed.
 *
 * ⚠ ONE ATTEMPT AT A TIME PER INSTANCE, AND NOT MORE OFTEN THAN {@link RETRY_INTERVAL}. The bound
 * sessions of a directory share one connection, so a message that finds an attempt running waits on
 * that one instead of starting another, and a backend that is down is not asked on every message.
 *
 * ⚠ A MESSAGE WAITS AT MOST {@link WAIT}, because this is on the path to its first token. An attempt
 * that takes longer carries on in the background, and a later message finds the server connected.
 *
 * ⚠ ONLY A FAILED SERVER. One the student switched off stays off, and one that discovery never
 * configured has nothing to connect to.
 */
export * as CourseServer from "./course-server"

import { JOLLI_MCP_SERVER } from "@opencode-ai/core/jolli/mcp"
import { Clock, Deferred, Duration, Effect, Option, type Scope } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MCP } from "@/mcp"

/** How long after one attempt starts the next may start. */
export const RETRY_INTERVAL = Duration.seconds(30)

/** How long a message waits for an attempt before it goes on without the course tools. */
export const WAIT = Duration.seconds(5)

/** The latest attempt in each instance directory: when it started, and whether it has finished. */
const attempts = new Map<string, { readonly startedAt: number; readonly done: Deferred.Deferred<void> }>()

/**
 * Reconnect the course server if it failed, and wait a bounded time for it. It never fails.
 *
 * `scope` outlives the message: an attempt the message stops waiting for keeps running in it.
 */
export const ensure = Effect.fn("CourseServer.ensure")(function* (scope: Scope.Scope) {
  const mcp = yield* MCP.Service
  const before = (yield* mcp.status())[JOLLI_MCP_SERVER]
  if (before?.status !== "failed") return
  const directory = yield* InstanceState.directory
  const now = yield* Clock.currentTimeMillis
  // From the lookup to the record without a yield, so two messages cannot both start an attempt.
  const last = attempts.get(directory)
  const running = last && !Deferred.isDoneUnsafe(last.done) ? last : undefined
  if (!running && last && now - last.startedAt < Duration.toMillis(RETRY_INTERVAL)) return
  const attempt = running ?? { startedAt: now, done: Deferred.makeUnsafe<void>() }
  if (!running) {
    attempts.set(directory, attempt)
    yield* mcp.connect(JOLLI_MCP_SERVER).pipe(
      // Only a server dropped from the config fails here; a refused connection is a failed status.
      Effect.catchCause((cause) => Effect.logWarning("jolli course server reconnect failed", { cause: String(cause) })),
      Effect.ensuring(Deferred.succeed(attempt.done, undefined)),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  }
  const finished = yield* Deferred.await(attempt.done).pipe(Effect.timeoutOption(WAIT))
  const after = (yield* mcp.status())[JOLLI_MCP_SERVER]
  yield* Effect.logInfo("jolli course server reconnect", {
    joined: !!running,
    finished: Option.isSome(finished),
    status: after?.status ?? "missing",
    previous: before.error,
  })
})
