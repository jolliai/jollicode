import { afterEach, expect, setSystemTime, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { gatewayRequest, type StudentAssignment } from "../src/jolli/api"
import { JolliAssignmentCache } from "../src/jolli/assignment-cache"
import { JolliSession } from "../src/jolli/session"
import { JolliTaskMode } from "../src/jolli/task-mode"

const binding = { courseId: "acme:school:7", assistantId: "acme:school:13" }
const task = { assignmentId: "40", partId: "42" }
const baseURL = "https://task-mode.jolli.dev"
const assignment = (explicit = false): StudentAssignment => ({
  id: 40,
  courseId: 7,
  title: "Practice",
  description: "",
  opensAt: null,
  dueAt: null,
  stopAtDue: false,
  status: "published",
  authorName: null,
  progress: { state: "in_progress", partsSubmitted: 0, partsTotal: 1, turnedInAt: null },
  parts: [
    {
      id: 42,
      kind: "agent",
      assistantId: 13,
      assistantName: "Coach",
      assistantBlurb: "",
      assistantStatus: "live",
      turnIn: { transcript: explicit, summary: false, reflection: false },
      reflectionPrompt: null,
      workedIn: "jolli_code",
      attempts: [],
      submission: null,
      owed: true,
    },
  ],
})

function setup(reply: (request: Request) => Response | Promise<Response>) {
  const reads: Request[] = []
  let identity = "student-a"
  let renewals = 0
  const layer = Layer.mergeAll(
    Layer.mock(JolliSession.Service, {
      current: () =>
        Effect.sync(() => ({
          id: "row",
          base_url: baseURL,
          cache_key: identity,
          access_token: "jwt",
          refresh_token: "refresh",
          token_expiry: 0,
          subject: null,
          email: null,
          time_created: 0,
          time_updated: 0,
        })),
      request: () =>
        Effect.sync(() => {
          renewals++
          return gatewayRequest(baseURL, { token: "jwt", identity })
        }),
    }),
    Layer.succeed(
      FetchHttpClient.Fetch,
      Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(String(input), init)
          reads.push(request)
          return reply(request)
        },
        { preconnect: fetch.preconnect },
      ),
    ),
  )
  return {
    reads,
    renewals: () => renewals,
    signIn: (value: string) => (identity = value),
    read: (course = binding) =>
      Effect.runPromise(JolliTaskMode.explicitSubmit(course, task).pipe(Effect.provide(layer))),
  }
}

const json = (body: unknown) => Response.json(body)

/** A known mode refreshes behind the turn, so a test waits for that read to land. */
async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

afterEach(() => {
  setSystemTime()
  JolliAssignmentCache.reset()
  JolliTaskMode.reset()
})

test("headless cold reads discover participation, coalesce, and refresh after TTL without UI", async () => {
  const now = Date.now()
  setSystemTime(now)
  const gateway = setup(() => json(assignment()))
  expect(await Promise.all([gateway.read(), gateway.read()])).toEqual([false, false])
  expect(gateway.reads).toHaveLength(1)
  expect(new URL(gateway.reads[0].url).pathname).toBe("/api/courses/7/assignments/40/student-view")
  expect(gateway.reads[0].headers.get("x-org-slug")).toBe("school")
  expect(await gateway.read()).toBe(false)
  expect(gateway.renewals()).toBe(1)
  setSystemTime(now + 60_001)
  expect(await gateway.read()).toBe(false)
  await until(() => gateway.reads.length === 2)
})

test("failed refresh retains participation policy and throttles retries", async () => {
  const now = Date.now()
  setSystemTime(now)
  let failed = false
  const gateway = setup(() => (failed ? new Response("offline", { status: 503 }) : json(assignment())))
  expect(await gateway.read()).toBe(false)
  failed = true
  setSystemTime(now + 60_001)
  expect(await gateway.read()).toBe(false)
  await until(() => gateway.reads.length > 1)
  await Bun.sleep(20)
  const attempts = gateway.reads.length
  expect(attempts).toBeGreaterThan(1)
  expect(await gateway.read()).toBe(false)
  expect(gateway.reads).toHaveLength(attempts)
})

test("UI reads immediately update mode; identity and org scope never share policy", async () => {
  const gateway = setup(() => json(assignment(true)))
  JolliAssignmentCache.keep("student-a", binding.courseId, assignment(), Date.now())
  expect(await gateway.read()).toBe(false)
  expect(gateway.reads).toHaveLength(0)
  expect(await gateway.read({ courseId: "acme:other:7", assistantId: "acme:other:13" })).toBe(true)
  expect(gateway.reads).toHaveLength(1)
  gateway.signIn("student-b")
  expect(await gateway.read()).toBe(true)
  expect(gateway.reads).toHaveLength(2)
  gateway.signIn("student-a")
  JolliAssignmentCache.keep("student-a", binding.courseId, assignment(true), Date.now())
  expect(await gateway.read()).toBe(true)
})

test("an unknown mode preserves legacy submit behavior when the gateway cannot answer", async () => {
  const gateway = setup(() => new Response("offline", { status: 503 }))
  expect(await gateway.read()).toBe(true)
  const attempts = gateway.reads.length
  expect(attempts).toBeGreaterThan(0)
  expect(await gateway.read()).toBe(true)
  expect(gateway.reads).toHaveLength(attempts)
})

test("a known mode answers a provider turn without waiting for its refresh", async () => {
  const now = Date.now()
  setSystemTime(now)
  let stall = false
  const gateway = setup(() => (stall ? new Promise<Response>(() => {}) : json(assignment())))
  expect(await gateway.read()).toBe(false)
  stall = true
  setSystemTime(now + 60_001)
  expect(await gateway.read()).toBe(false)
  await until(() => gateway.reads.length === 2)
})
