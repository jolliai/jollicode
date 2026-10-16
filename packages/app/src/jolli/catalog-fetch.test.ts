import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"

type Listener = (event: { name: string; details: unknown }) => void

const listeners = new Set<Listener>()
let useRefusalRefresh: typeof import("./catalog-fetch").useRefusalRefresh
let catalogGeneration: typeof import("./catalog").catalogGeneration
let catalogRefreshed: typeof import("./catalog").catalogRefreshed

/** The server's event stream, as `serverSDK().event.listen` hands it out — nothing else is used. */
beforeAll(async () => {
  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({
      event: {
        listen: (listener: Listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }),
  }))
  const fetch = await import("./catalog-fetch")
  useRefusalRefresh = fetch.useRefusalRefresh
  const catalog = await import("./catalog")
  catalogGeneration = catalog.catalogGeneration
  catalogRefreshed = catalog.catalogRefreshed
})

const emit = (details: unknown) => listeners.forEach((listener) => listener({ name: "/repo", details }))

/** A turn the provider failed, carrying `responseBody` as the gateway sent it. */
const failed = (responseBody?: string) => ({
  type: "session.error",
  properties: {
    sessionID: "ses_1",
    error: { name: "APIError", data: { message: "Forbidden", isRetryable: false, responseBody } },
  },
})

/** Owners still mounted, disposed after each test even when an assertion stopped it early. */
const owners: Array<() => void> = []
const mounted = () => {
  const dispose = createRoot((dispose) => (useRefusalRefresh(), dispose))
  owners.push(dispose)
  return dispose
}
afterEach(() => owners.splice(0).forEach((dispose) => dispose()))

describe("useRefusalRefresh", () => {
  test("a turn the gateway refused asks for the catalogue past the server's cache", () => {
    mounted()
    const before = catalogGeneration()

    emit(failed(JSON.stringify({ error: "This agent has closed.", code: "assistant_closed" })))

    expect(catalogGeneration()).toBe(before + 1)
    expect(catalogRefreshed(catalogGeneration())).toBe(true)
  })

  // The draft route nests two `CourseSessionProvider`s, and each runs this hook.
  test("one refusal refreshes once, however many listen", () => {
    mounted()
    mounted()
    const before = catalogGeneration()

    emit(failed(JSON.stringify({ code: "assistant_closed" })))

    expect(catalogGeneration()).toBe(before + 1)
  })

  test("any other failure, or any other event, leaves the catalogue alone", () => {
    mounted()
    const before = catalogGeneration()

    emit(failed(JSON.stringify({ error: "Too many requests", code: "rate_limited" })))
    emit(failed("Bad Gateway"))
    emit(failed())
    emit({ type: "session.error", properties: { error: { name: "UnknownError", data: { message: "boom" } } } })
    emit({ type: "session.idle", properties: { sessionID: "ses_1" } })

    expect(catalogGeneration()).toBe(before)
  })

  test("stops listening once its owner is gone", () => {
    const dispose = mounted()
    dispose()
    const before = catalogGeneration()

    emit(failed(JSON.stringify({ code: "assistant_closed" })))

    expect(listeners.size).toBe(0)
    expect(catalogGeneration()).toBe(before)
  })
})
