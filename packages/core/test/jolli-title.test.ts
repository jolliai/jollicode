import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { TestClock } from "effect/testing"
import type { GatewayRequest } from "../src/jolli/api"
import { JolliSession } from "../src/jolli/session"
import { syncTitle } from "../src/jolli/title"
import { it } from "./lib/effect"

const REQUEST: GatewayRequest = { origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * ⚠ THE SESSION SERVICE IS STUBBED DOWN TO THE TWO CALLS `syncTitle` MAKES. Whether a credential is
 * usable is `jolli-session.test.ts`'s question; this one is what happens to a title once it is.
 */
function harness(input: { request?: GatewayRequest; respond: (attempt: number) => Response }) {
  const seen: HttpClientRequest.HttpClientRequest[] = []
  const refused: string[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        seen.push(request)
        return Effect.succeed(HttpClientResponse.fromWeb(request, input.respond(seen.length)))
      }),
    ),
    Layer.succeed(JolliSession.Service, {
      current: () => Effect.succeed(undefined),
      token: () => Effect.die("unused"),
      request: () => Effect.succeed(input.request),
      refused: (token: string) => Effect.sync(() => refused.push(token)).pipe(Effect.as("renewed")),
      signIn: () => Effect.die("unused"),
      signOut: () => Effect.die("unused"),
    }),
  )
  return { seen, refused, layer }
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined) =>
  request?.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined

describe("syncTitle", () => {
  it.effect("patches the conversation named by the session id with the title", () =>
    Effect.gen(function* () {
      const h = harness({ request: REQUEST, respond: () => json({}) })
      yield* syncTitle("ses_1", "Fix the linked list").pipe(Effect.provide(h.layer))
      expect(h.seen).toHaveLength(1)
      expect(h.seen[0]?.method).toBe("PATCH")
      expect(h.seen[0]?.url).toBe("https://acme.jolli.ai/api/agent/convos/ses_1")
      expect(h.seen[0]?.headers["authorization"]).toBe("Bearer jwt")
      expect(bodyOf(h.seen[0])).toEqual({ title: "Fix the linked list" })
    }),
  )

  it.effect("sends nothing when there is no usable credential", () =>
    Effect.gen(function* () {
      const h = harness({ respond: () => json({}) })
      yield* syncTitle("ses_1", "Title").pipe(Effect.provide(h.layer))
      expect(h.seen).toHaveLength(0)
    }),
  )

  it.effect("waits out a conversation the gateway has not created yet", () =>
    Effect.gen(function* () {
      const h = harness({ request: REQUEST, respond: (attempt) => (attempt < 3 ? json({}, 404) : json({})) })
      const fiber = yield* syncTitle("ses_1", "Title").pipe(Effect.provide(h.layer), Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      yield* Fiber.join(fiber)
      expect(h.seen).toHaveLength(3)
    }),
  )

  it.effect("gives up on a conversation that never appears, without failing", () =>
    Effect.gen(function* () {
      const h = harness({ request: REQUEST, respond: () => json({}, 404) })
      const fiber = yield* syncTitle("ses_1", "Title").pipe(Effect.provide(h.layer), Effect.forkChild)
      yield* TestClock.adjust("1 minute")
      yield* Fiber.join(fiber)
      expect(h.seen).toHaveLength(5)
    }),
  )

  it.effect("renews a refused token instead of retrying the rename", () =>
    Effect.gen(function* () {
      const h = harness({ request: REQUEST, respond: () => json({ error: "Unauthorized" }, 401) })
      yield* syncTitle("ses_1", "Title").pipe(Effect.provide(h.layer))
      expect(h.seen).toHaveLength(1)
      expect(h.refused).toEqual(["jwt"])
    }),
  )

  it.effect("swallows any other refusal", () =>
    Effect.gen(function* () {
      const h = harness({ request: REQUEST, respond: () => json({ error: "boom" }, 500) })
      yield* syncTitle("ses_1", "Title").pipe(Effect.provide(h.layer))
      expect(h.seen).toHaveLength(1)
      expect(h.refused).toEqual([])
    }),
  )
})
