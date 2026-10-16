import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import type { GatewayRequest } from "@opencode-ai/core/jolli/api"
import { projectCatalog } from "@opencode-ai/core/jolli/catalog"
import { JolliClosedAssistants } from "@opencode-ai/core/jolli/closed-assistants"
import type { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { startJolliSession } from "../../src/server/routes/instance/httpapi/handlers/session"

// A refusal is process memory; one left behind would close the same assistant for every later test.
afterEach(() => JolliClosedAssistants.reset())

const REQUEST: GatewayRequest = { origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }
/** The directory every Start here is asked in, unless a test says otherwise. */
const DIRECTORY = "/repo/main"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * ⚠ THE GATEWAY IS A STUBBED `HttpClient` AND THE LOCAL CREATE A RECORDING FUNCTION, which is the
 * whole surface the start flow touches. What is under test is the ORDER — the gateway first, the
 * local session only after it said yes — so each case asserts what was sent and what was created.
 */
function harness(
  respond: (request: HttpClientRequest.HttpClientRequest) => Response | "transport",
  sessions: Session.Info[] = [],
) {
  const sent: HttpClientRequest.HttpClientRequest[] = []
  const created: (Session.CreateInput & { id: SessionID })[] = []
  const renewed: string[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push(request)
      const answer = respond(request)
      if (answer === "transport")
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
          }),
        )
      // A real gateway answers later; the pause is what lets two Starts overlap.
      return Effect.sleep("1 millis").pipe(Effect.as(HttpClientResponse.fromWeb(request, answer)))
    }),
  )
  const start = (
    payload: { courseId: string; assistantId: string; agent?: string; sessionID?: SessionID },
    request = REQUEST,
    directory = DIRECTORY,
  ) =>
    startJolliSession({
      payload,
      directory,
      gateway: {
        request: () => Effect.succeed(request),
        refused: (token) => Effect.sync(() => renewed.push(token)).pipe(Effect.as(token)),
      },
      existing: (id) => Effect.succeed(sessions.find((item) => item.id === id)),
      create: (input) =>
        Effect.sync(() => {
          created.push(input)
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `id`, `directory` and `metadata` are read back.
          const session = { id: input.id, directory, metadata: input.metadata } as unknown as Session.Info
          sessions.push(session)
          return session
        }),
    }).pipe(Effect.provide(layer))
  return { sent, created, renewed, start, layer }
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  const body = request?.body
  return JSON.parse(new TextDecoder().decode(body?._tag === "Uint8Array" ? body.body : undefined))
}

describe("startJolliSession", () => {
  test("opens the conversation under a fresh id, then creates the local session with it and the opener", async () => {
    const h = harness(() => json({ config: { opener: { text: "Hi Maya, I'm Dana." } } }, 201))
    const result = await Effect.runPromise(h.start({ courseId: "7", assistantId: "12", agent: "build" }))

    expect(h.sent).toHaveLength(1)
    const body = bodyOf(h.sent[0])
    expect(body).toMatchObject({ spaceId: 7, courseAssistantId: 12, origin: "coding_agent" })
    expect(body.publicSessionId).toMatch(/^ses_[A-Za-z0-9_-]+$/)

    expect(h.created).toHaveLength(1)
    const created = h.created[0]!
    expect(created.id).toBe(body.publicSessionId)
    expect(created.agent).toBe("build")
    expect(created.metadata).toEqual({
      jolli: { courseId: "7", assistantId: "12" },
      jolliOpener: { sessionID: body.publicSessionId, text: "Hi Maya, I'm Dana." },
    })
    expect(result).toMatchObject({ status: "started", opener: true, session: { id: body.publicSessionId } })
  })

  /** ⚠ NO OPENER IS A NORMAL SUCCESS: the student enters the session and types first, as on the web. */
  test("a conversation opened without an opener starts a plain bound session", async () => {
    const h = harness(() => json({ config: {} }, 201))
    const result = await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))
    // Still recorded as started, so the binding is locked before the first message.
    expect(h.created[0]?.metadata).toEqual({
      jolli: { courseId: "7", assistantId: "12" },
      jolliOpener: { sessionID: h.created[0]?.id },
    })
    expect(result).toMatchObject({ status: "started", opener: false })
  })

  /** ⚠ A REFUSAL LEAVES NOTHING BEHIND: no empty local session for the student to find later. */
  test("a refusal creates nothing and answers with the gateway's code", async () => {
    const h = harness(() => json({ error: "This agent has closed.", code: "assistant_closed" }, 409))
    expect(await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))).toEqual({
      status: "refused",
      code: "assistant_closed",
    })
    expect(h.created).toEqual([])
  })

  /**
   * ⚠ A CLOSED REFUSAL OUTLIVES THE REQUEST. A clock behind the gateway's reads the same window as
   * open after every refresh, so the catalogue this process serves next has to say it is closed.
   */
  test("an assistant refused as closed is served closed from then on", async () => {
    const catalog = () =>
      JolliClosedAssistants.apply(
        projectCatalog(
          {
            courses: [
              {
                id: 7,
                name: "Systems Programming",
                description: "",
                code: "CS 310",
                status: "published",
                requiresCoding: true,
                endsOn: null,
                viewerRole: "course-student",
                isStaff: false,
              },
            ],
            assistants: {
              "7": [
                {
                  id: 4012,
                  name: "Tutor",
                  blurb: "",
                  icon: "Terminal",
                  accent: 0,
                  worksThroughProblems: false,
                  answersFromMaterialsOnly: false,
                  showCitations: false,
                  modelId: "",
                  allowedModelIds: [],
                  endsAt: "2999-01-01T00:00:00.000Z",
                },
              ],
            },
            models: [],
          },
          "2026-10-15",
        ),
      ).assistants[0]?.endsAt
    expect(catalog()).toBe("2999-01-01T00:00:00.000Z")

    const h = harness(() => json({ error: "This agent has closed.", code: "assistant_closed" }, 409))
    await Effect.runPromise(h.start({ courseId: "7", assistantId: "4012" }))

    expect(Date.parse(catalog()!)).toBeLessThanOrEqual(Date.now())
  })

  test("a 404 with no code is an assistant that is gone", async () => {
    const h = harness(() => json({ error: "Not found" }, 404))
    expect(await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))).toEqual({
      status: "refused",
      code: "assistant_not_found",
    })
    expect(h.created).toEqual([])
  })

  test("a refusal that names no reason answers without a code", async () => {
    const h = harness(() => json({ error: "Bad request" }, 400))
    expect(await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))).toEqual({ status: "refused" })
  })

  /**
   * ⚠ A FAILURE IS NEVER "NO OPENER". The gateway may have stored one the student did not see, so
   * an unanswered Start must not fall through to an empty session.
   */
  test("no answer at all creates nothing and answers unreachable", async () => {
    const h = harness(() => "transport")
    expect(await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))).toEqual({ status: "unreachable" })
    expect(h.created).toEqual([])
    // Retried once with the same id, since the call is idempotent by id.
    expect(h.sent).toHaveLength(2)
    expect(bodyOf(h.sent[1]).publicSessionId).toBe(bodyOf(h.sent[0]).publicSessionId)
  })

  /** ⚠ THE GATEWAY MADE THE CONVERSATION; NOTHING ABOUT THE COURSE CHANGED, SO IT IS NO REFUSAL. */
  test("a success whose body cannot be read is a failure, not a refusal", async () => {
    const h = harness(() => json({ config: { opener: "Hi" } }, 201))
    expect(await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))).toEqual({ status: "unreachable" })
    expect(h.created).toEqual([])
  })

  test("a refused token is renewed, and the student may simply try again", async () => {
    const h = harness(() => json({ error: "Unauthorized" }, 401))
    expect(await Effect.runPromise(h.start({ courseId: "7", assistantId: "12" }))).toEqual({ status: "unreachable" })
    expect(h.renewed).toEqual(["jwt"])
    expect(h.created).toEqual([])
  })

  test("signed out, nothing is asked and nothing is created", async () => {
    const h = harness(() => json({}))
    const result = await Effect.runPromise(
      startJolliSession({
        payload: { courseId: "7", assistantId: "12" },
        directory: DIRECTORY,
        gateway: { request: () => Effect.succeed(undefined), refused: (token) => Effect.succeed(token) },
        existing: () => Effect.succeed(undefined),
        create: () => Effect.die("must not create"),
      }).pipe(Effect.provide(h.layer)),
    )
    expect(result).toEqual({ status: "unreachable" })
    expect(h.sent).toEqual([])
  })

  test("a binding that is not a pair of gateway ids is a bad request, asked of nobody", async () => {
    const h = harness(() => json({}))
    // `Number()` reads all of these as a fine id, but the binding stored would be the raw string.
    for (const payload of [
      { courseId: "seven", assistantId: "12" },
      { courseId: "7", assistantId: "0" },
      { courseId: "7", assistantId: "1.5" },
      { courseId: "1e1", assistantId: "12" },
      { courseId: " 7", assistantId: "12" },
      { courseId: "0x7", assistantId: "12" },
      { courseId: "07", assistantId: "12" },
    ]) {
      const exit = await Effect.runPromise(Effect.exit(h.start(payload)))
      expect(exit._tag).toBe("Failure")
    }
    expect(h.sent).toEqual([])
    expect(h.created).toEqual([])
  })

  /** ⚠ THE GATEWAY IS IDEMPOTENT BY ID, SO A RETRY UNDER THE SAME ONE CANNOT LEAVE AN ORPHAN BEHIND. */
  test("a retry opens the conversation under the id the client sent", async () => {
    const h = harness(() => json({ config: { opener: { text: "Hi." } } }, 201))
    const sessionID = SessionID.descending()
    const result = await Effect.runPromise(h.start({ courseId: "7", assistantId: "12", sessionID }))
    expect(bodyOf(h.sent[0]).publicSessionId).toBe(sessionID)
    expect(h.created[0]?.id).toBe(sessionID)
    expect(result).toMatchObject({ status: "started", session: { id: sessionID } })
  })

  // The first try got as far as the local session, and only its answer was lost.
  test("a retry whose session already exists answers with it and asks nobody", async () => {
    const sessionID = SessionID.descending()
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `id`, `directory` and `metadata` are read.
    const existing = {
      id: sessionID,
      directory: DIRECTORY,
      metadata: { jolli: { courseId: "7", assistantId: "12" }, jolliOpener: { sessionID, text: "Hi." } },
    } as unknown as Session.Info
    const h = harness(() => json({}), [existing])
    const result = await Effect.runPromise(h.start({ courseId: "7", assistantId: "12", sessionID }))
    expect(result).toEqual({ status: "started", session: existing, opener: true })
    expect(h.sent).toEqual([])
    expect(h.created).toEqual([])
  })

  /**
   * ⚠ ANSWERED FROM ANOTHER PROJECT, THE CLIENT WOULD FILE THE SESSION THERE. The id was adopted by a
   * draft elsewhere after the first answer was lost; refused, the client starts over under a new id.
   */
  test("a retry from another directory than its session's is a bad request, asked of nobody", async () => {
    const sessionID = SessionID.descending()
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `id`, `directory` and `metadata` are read.
    const existing = {
      id: sessionID,
      directory: "/repo/other",
      metadata: { jolli: { courseId: "7", assistantId: "12" }, jolliOpener: { sessionID, text: "Hi." } },
    } as unknown as Session.Info
    const h = harness(() => json({}), [existing])
    const exit = await Effect.runPromise(Effect.exit(h.start({ courseId: "7", assistantId: "12", sessionID })))
    expect(exit._tag).toBe("Failure")
    expect(h.sent).toEqual([])
    expect(h.created).toEqual([])
  })

  /**
   * ⚠ A RETRY THAT OVERTAKES THE FIRST TRY WAITS FOR IT. Both passing the `existing` check while the
   * first is still with the gateway would create the session twice — a collision, not the same session.
   */
  test("two Starts under one id at once create one session and both answer with it", async () => {
    const h = harness(() => json({ config: { opener: { text: "Hi." } } }, 201))
    const sessionID = SessionID.descending()
    const results = await Effect.runPromise(
      Effect.all(
        [
          h.start({ courseId: "7", assistantId: "12", sessionID }),
          h.start({ courseId: "7", assistantId: "12", sessionID }),
        ],
        {
          concurrency: "unbounded",
        },
      ),
    )
    expect(h.created).toHaveLength(1)
    expect(h.sent).toHaveLength(1)
    expect(results.map((result) => result.status === "started" && result.session.id)).toEqual([sessionID, sessionID])
  })

  test("an id that names some other session is a bad request", async () => {
    const sessionID = SessionID.descending()
    const unrelated = { id: sessionID, metadata: { jolli: { courseId: "7", assistantId: "12" } } }
    const otherBinding = {
      id: sessionID,
      metadata: { jolli: { courseId: "7", assistantId: "13" }, jolliOpener: { sessionID } },
    }
    for (const session of [unrelated, otherBinding]) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `id` and `metadata` are read.
      const h = harness(() => json({}), [session as unknown as Session.Info])
      const exit = await Effect.runPromise(Effect.exit(h.start({ courseId: "7", assistantId: "12", sessionID })))
      expect(exit._tag).toBe("Failure")
      expect(h.sent).toEqual([])
    }
  })
})
