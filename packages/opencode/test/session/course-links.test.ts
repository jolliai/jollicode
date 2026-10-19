import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CourseLinks } from "@/session/course-links"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

// The session store is the real one, so the answer is read back and written under its own rules. Only
// the credential and the gateway are stood in for.
const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, MessageV2.node, SessionProjector.node])))

const ASSIGNMENTS = "https://school.jolli.ai/learn/44/assignments"

/** A session with one finished turn: the student's question, then the answer that turned it down. */
const answeredTurn = Effect.fn("Test.answeredTurn")(function* (answerMetadata?: Record<string, unknown>) {
  const sessions = yield* Session.Service
  const sessionID = (yield* sessions.create({})).id
  const userID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "jolli-anthropic", modelID: "sonnet" },
  } as unknown as SessionV1.Info)
  const answerMessageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: answerMessageID,
    sessionID,
    role: "assistant",
    parentID: userID,
    providerID: ProviderV2.ID.make("jolli-anthropic"),
    modelID: ModelV2.ID.make("sonnet"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 2, completed: 2 },
  } as unknown as SessionV1.Info)
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: answerMessageID,
    type: "text",
    text: "With this assistant's current settings I cannot look up assignments.",
    ...(answerMetadata === undefined ? {} : { metadata: answerMetadata }),
  } as unknown as SessionV1.Part)
  return { sessionID, userID, answer: { messageID: answerMessageID, partID: part.id } }
})

/** Run the links over the real store, the gateway answering `reply` to every request it is sent. */
const attach = Effect.fn("Test.attach")(function* (input: {
  readonly sessionID: SessionID
  readonly userMessageID: MessageID
  readonly reply: unknown
  readonly signedIn?: boolean
}) {
  const seen: HttpClientRequest.HttpClientRequest[] = []
  const gateway = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      seen.push(request)
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(input.reply), { headers: { "content-type": "application/json" } }),
        ),
      )
    }),
  )
  const credential = Layer.mock(JolliSession.Service)({
    request: () =>
      Effect.succeed(
        input.signedIn === false
          ? undefined
          : { origin: "https://school.jolli.ai", token: "jwt", identity: "student-a" },
      ),
  })
  yield* CourseLinks.attach({ sessionID: input.sessionID, userMessageID: input.userMessageID }).pipe(
    Effect.provide(Layer.mergeAll(gateway, credential)),
  )
  return seen
})

const stored = Effect.fn("Test.stored")(function* (
  sessionID: SessionID,
  answer: { messageID: MessageID; partID: PartID },
) {
  const sessions = yield* Session.Service
  const part = yield* sessions.getPart({ sessionID, messageID: answer.messageID, partID: answer.partID })
  return part?.type === "text" ? part : undefined
})

describe("CourseLinks.attach", () => {
  it.instance("asks the gateway about the turn it opened and writes the Assignments link onto the answer", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn({ answerSources: [] })
      const seen = yield* attach({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        reply: { assignmentsUrl: ASSIGNMENTS },
      })
      expect(seen.map((request) => request.url)).toEqual([
        `https://school.jolli.ai/api/agent/convos/${turn.sessionID}/turns/${turn.userID}/course-links`,
      ])
      // Beside what is already there, which the sources' own write must not lose either.
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toEqual({
        answerSources: [],
        assignmentsUrl: ASSIGNMENTS,
      })
    }),
  )

  it.instance("writes nothing for a turn the gateway has no link for, or a link that is not http(s)", () =>
    Effect.gen(function* () {
      const none = yield* answeredTurn()
      yield* attach({ sessionID: none.sessionID, userMessageID: none.userID, reply: { assignmentsUrl: null } })
      expect((yield* stored(none.sessionID, none.answer))?.metadata).toBeUndefined()

      const script = yield* answeredTurn()
      yield* attach({
        sessionID: script.sessionID,
        userMessageID: script.userID,
        reply: { assignmentsUrl: "javascript:alert(1)" },
      })
      expect((yield* stored(script.sessionID, script.answer))?.metadata).toBeUndefined()
    }),
  )

  it.instance("asks nothing without a credential, or for an answer that already carries its link", () =>
    Effect.gen(function* () {
      const signedOut = yield* answeredTurn()
      const unsent = yield* attach({
        sessionID: signedOut.sessionID,
        userMessageID: signedOut.userID,
        reply: { assignmentsUrl: ASSIGNMENTS },
        signedIn: false,
      })
      expect(unsent).toEqual([])

      const linked = yield* answeredTurn({ assignmentsUrl: ASSIGNMENTS })
      const again = yield* attach({
        sessionID: linked.sessionID,
        userMessageID: linked.userID,
        reply: { assignmentsUrl: ASSIGNMENTS },
      })
      expect(again).toEqual([])
    }),
  )
})
