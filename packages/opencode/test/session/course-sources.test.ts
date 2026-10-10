import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Exit, Layer, Stream } from "effect"
import { Provider } from "@/provider/provider"
import { CourseSources } from "@/session/course-sources"
import { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

// The session store is the real one, so the turn is read back through its own paging and written
// under its own constraints. Only the model is stood in for: the provider and the stream it answers on.
const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, MessageV2.node, SessionProjector.node])))

const lecture = { kind: "material", materialId: "3", title: "Lecture 4", text: "A pointer holds an address." }

type Fixture = { info: Record<string, unknown> & { id: MessageID }; parts: Record<string, unknown>[] }

function user(sessionID: SessionID, created: number, parts: Record<string, unknown>[] = []): Fixture {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "jolli-anthropic", modelID: "sonnet" },
      system: "the student's own system text",
    },
    parts,
  }
}

function assistant(
  sessionID: SessionID,
  parentID: MessageID,
  created: number,
  parts: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): Fixture {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID,
      providerID: ProviderV2.ID.make("jolli-anthropic"),
      modelID: ModelV2.ID.make("sonnet"),
      mode: "",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, completed: created },
      ...over,
    },
    parts,
  }
}

function read(evidence: unknown[] = [lecture], time = { start: 2, end: 3 }) {
  return {
    type: "tool",
    callID: `call_${PartID.ascending()}`,
    tool: "jolliedu_get_remote_material_content",
    state: { status: "completed", input: {}, output: "", title: "", metadata: { evidence }, time },
  }
}

function text(value: string, over: Record<string, unknown> = {}) {
  return { type: "text", text: value, ...over }
}

/** The close of a step that wrote nothing. */
function finished() {
  return {
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

/** Write the fixtures into the store in order, answering the ids each part was given. */
const write = Effect.fn("Test.write")(function* (...messages: Fixture[]) {
  const sessions = yield* Session.Service
  return yield* Effect.forEach(messages, (message) =>
    Effect.gen(function* () {
      yield* sessions.updateMessage(message.info as unknown as SessionV1.Info)
      return yield* Effect.forEach(message.parts, (part) =>
        sessions
          .updatePart({
            id: PartID.ascending(),
            sessionID: message.info.sessionID,
            messageID: message.info.id,
            ...part,
          } as unknown as SessionV1.Part)
          .pipe(Effect.map((written) => written.id)),
      )
    }),
  )
})

/** A session with one finished turn: the student's question, then a step that read the lecture and answered. */
const answeredTurn = Effect.fn("Test.answeredTurn")(function* (over: { error?: unknown; evidence?: unknown[] } = {}) {
  const sessions = yield* Session.Service
  const sessionID = (yield* sessions.create({})).id
  const question = user(sessionID, 1)
  const step = assistant(
    sessionID,
    question.info.id,
    2,
    [read(over.evidence ?? [lecture]), text("A pointer holds an address.")],
    over.error ? { error: over.error } : {},
  )
  const [, [, answerID]] = yield* write(question, step)
  return { sessionID, userID: question.info.id, answer: { messageID: step.info.id, partID: answerID } }
})

/** The answer part as it is stored now, or undefined when it is gone. */
const stored = Effect.fn("Test.stored")(function* (
  sessionID: SessionID,
  answer: { messageID: MessageID; partID: PartID },
) {
  const sessions = yield* Session.Service
  const part = yield* sessions.getPart({ sessionID, messageID: answer.messageID, partID: answer.partID })
  return part?.type === "text" ? part : undefined
})

/**
 * Run the attribution over the real store, with the selection model answering `replies` in turn.
 *
 * `visited` is every message the reading looked at, newest first. `afterReadBack` runs once the answer
 * has been read back for writing, before its sources are written onto it.
 */
const attribute = Effect.fn("Test.attribute")(function* (input: {
  readonly sessionID: SessionID
  readonly userMessageID: MessageID
  readonly replies: readonly string[]
  readonly citationsShown?: boolean
  readonly duringSelection?: Effect.Effect<void>
  readonly afterReadBack?: Effect.Effect<void>
}) {
  const store = yield* Session.Service
  const visited: string[] = []
  const calls: LLM.StreamInput[] = []
  const switches = { asked: 0 }
  const observed = Session.Service.of({
    ...store,
    findMessage: (sessionID, predicate) =>
      store.findMessage(sessionID, (message) => {
        visited.push(message.info.id)
        return predicate(message)
      }),
    getPart: (part) => store.getPart(part).pipe(Effect.tap(() => input.afterReadBack ?? Effect.void)),
  })
  const model = Layer.mergeAll(
    Layer.mock(Provider.Service)({ getModel: () => Effect.succeed({ id: "sonnet" } as unknown as Provider.Model) }),
    Layer.mock(LLM.Service)({
      stream: (request) => {
        calls.push(request)
        const reply = input.replies[calls.length - 1] ?? ""
        return Stream.unwrap(
          (input.duringSelection ?? Effect.void).pipe(
            Effect.as(Stream.make(LLMEvent.textDelta({ id: "t", text: reply }), LLMEvent.finish({ reason: "stop" }))),
          ),
        )
      },
    }),
  )
  const exit = yield* CourseSources.attribute({
    sessionID: input.sessionID,
    userMessageID: input.userMessageID,
    citationsShown: Effect.sync(() => {
      switches.asked++
      return input.citationsShown ?? true
    }),
  }).pipe(Effect.provideService(Session.Service, observed), Effect.provide(model), Effect.exit)
  return { calls, visited, switches, exit }
})

/**
 * A turn auto-compaction cut in two: the student's message, a step that read the lecture, the
 * compaction message and its summary, then the synthetic "continue" message and the steps under it.
 */
const compactedTurn = Effect.fn("Test.compactedTurn")(function* (over: { before?: Record<string, unknown>[] } = {}) {
  const sessions = yield* Session.Service
  const sessionID = (yield* sessions.create({})).id
  const question = user(sessionID, 1)
  const earlier = assistant(sessionID, question.info.id, 2, [read(), ...(over.before ?? [])], { finish: "tool-calls" })
  const compaction = user(sessionID, 3, [{ type: "compaction", auto: true }])
  const summary = assistant(sessionID, compaction.info.id, 4, [text("We read Lecture 4.")], { summary: true })
  const carryOn = user(sessionID, 5, [
    text("Continue if you have next steps.", { synthetic: true, metadata: { compaction_continue: true } }),
  ])
  return { sessionID, question, earlier, compaction, summary, carryOn }
})

describe("CourseSources.attribute", () => {
  it.instance("writes the sources the selection picked onto the answer's text part", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn()
      yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toEqual({
        answerSources: [{ kind: "material", materialId: "3", title: "Lecture 4" }],
      })
    }),
  )

  it.instance("briefs the selection alone, without the course prompt, tools or the student's system text", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn()
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":[]}'],
      })
      const request = run.calls[0]
      expect(request?.system).toEqual([])
      expect(request?.tools).toEqual({})
      expect(request?.agent.prompt).toContain("Select only sources whose supplied evidence directly supports")
      expect(request?.user.system).toBeUndefined()
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toEqual({ answerSources: [] })
    }),
  )

  it.instance("corrects an unreadable reply once, telling the model what was wrong", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn()
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ["the first one", '{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toHaveLength(2)
      const retry = run.calls[1]?.messages ?? []
      expect(retry.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(JSON.stringify(retry[2])).toContain("the reply contained no complete JSON object")
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toHaveProperty("answerSources")
    }),
  )

  it.instance("writes nothing when the corrected retry fails too", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn()
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ["no", "still no"],
      })
      expect(run.calls).toHaveLength(2)
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toBeUndefined()
    }),
  )

  it.instance("asks nothing when the turn's tools returned no evidence, nor whether the course shows citations", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn({ evidence: [] })
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toEqual([])
      expect(run.switches.asked).toBe(0)
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toBeUndefined()
    }),
  )

  it.instance("asks the model nothing where the course hides citations", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn()
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
        citationsShown: false,
      })
      expect(run.switches.asked).toBe(1)
      expect(run.calls).toEqual([])
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toBeUndefined()
    }),
  )

  it.instance("asks nothing about a turn that failed", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn({ error: { name: "APIError", data: { message: "down", isRetryable: false } } })
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toEqual([])
    }),
  )

  it.instance("finds the answer in an earlier step when the turn ended on a step that wrote nothing", () =>
    Effect.gen(function* () {
      const turn = yield* answeredTurn()
      yield* write(assistant(turn.sessionID, turn.userID, 3, [finished()]))
      yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toMatchObject({
        answerSources: [{ materialId: "3" }],
      })
    }),
  )

  it.instance("reads the session back only as far as the turn's own message", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      const older = user(sessionID, 1)
      const question = user(sessionID, 2)
      const step = assistant(sessionID, question.info.id, 3, [read(), text("A pointer holds an address.")])
      yield* write(older, question, step)
      const run = yield* attribute({
        sessionID,
        userMessageID: question.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toHaveLength(1)
      expect(run.visited).toEqual([step.info.id, question.info.id])
    }),
  )

  it.instance("reads a turn longer than one page of the session whole", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      const question = user(sessionID, 1)
      // The lecture is read in the first step, and the answer comes past the session's page of 50.
      const steps = Array.from({ length: 60 }, (_, index) =>
        assistant(sessionID, question.info.id, 2 + index, index === 0 ? [read()] : [{ type: "step-start" }], {
          finish: "tool-calls",
        }),
      )
      const answer = assistant(sessionID, question.info.id, 100, [text("A pointer holds an address.")])
      const written = yield* write(question, ...steps, answer)
      const run = yield* attribute({
        sessionID,
        userMessageID: question.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(JSON.stringify(run.calls[0]?.messages)).toContain(lecture.text)
      const answerPart = { messageID: answer.info.id, partID: written.at(-1)![0] }
      expect((yield* stored(sessionID, answerPart))?.metadata).toMatchObject({ answerSources: [{ materialId: "3" }] })
    }),
  )

  it.instance("judges a turn auto-compaction cut in two whole, from the materials read before it", () =>
    Effect.gen(function* () {
      const turn = yield* compactedTurn()
      const answer = assistant(turn.sessionID, turn.carryOn.info.id, 6, [text("A pointer holds an address.")])
      const written = yield* write(turn.question, turn.earlier, turn.compaction, turn.summary, turn.carryOn, answer)
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.carryOn.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(JSON.stringify(run.calls[0]?.messages)).toContain(lecture.text)
      expect(JSON.stringify(run.calls[0]?.messages)).not.toContain("We read Lecture 4.")
      const answerPart = { messageID: answer.info.id, partID: written.at(-1)![0] }
      expect((yield* stored(turn.sessionID, answerPart))?.metadata).toMatchObject({
        answerSources: [{ materialId: "3" }],
      })
    }),
  )

  it.instance("finds an answer left before a compaction when the steps after it wrote nothing", () =>
    Effect.gen(function* () {
      const turn = yield* compactedTurn({ before: [text("A pointer holds an address.")] })
      const after = assistant(turn.sessionID, turn.carryOn.info.id, 6, [finished()])
      const written = yield* write(turn.question, turn.earlier, turn.compaction, turn.summary, turn.carryOn, after)
      yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.carryOn.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      const answerPart = { messageID: turn.earlier.info.id, partID: written[1][1] }
      expect((yield* stored(turn.sessionID, answerPart))?.metadata).toMatchObject({
        answerSources: [{ materialId: "3" }],
      })
    }),
  )

  it.instance("judges what a subagent read during the turn's task call, and nothing it read in another run", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({})).id
      const subagentID = (yield* sessions.create({})).id
      const earlierRun = { ...lecture, materialId: "8", title: "Lab 1", text: "An earlier run's reading." }
      const laterRun = { ...lecture, materialId: "9", title: "Lab 2", text: "A later run's reading." }
      const subagentStep = (parentID: MessageID, created: number, evidence: unknown) =>
        assistant(subagentID, parentID, created, [read([evidence], { start: created, end: created })])
      const firstAsk = user(subagentID, 4)
      const secondAsk = user(subagentID, 11)
      const thirdAsk = user(subagentID, 24)
      yield* write(
        firstAsk,
        subagentStep(firstAsk.info.id, 5, earlierRun),
        secondAsk,
        subagentStep(secondAsk.info.id, 12, lecture),
        thirdAsk,
        subagentStep(thirdAsk.info.id, 25, laterRun),
      )

      // The answer's step ran a `task` call from 10 to 20, and read nothing itself.
      const question = user(sessionID, 1)
      const task = {
        type: "tool",
        callID: "call_task",
        tool: "task",
        state: {
          status: "completed",
          input: {},
          output: "Lecture 4 says a pointer holds an address.",
          title: "",
          metadata: { sessionId: subagentID },
          time: { start: 10, end: 20 },
        },
      }
      const step = assistant(sessionID, question.info.id, 21, [task, text("A pointer holds an address.")])
      const [, [, answerID]] = yield* write(question, step)

      const run = yield* attribute({
        sessionID,
        userMessageID: question.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      const request = JSON.stringify(run.calls[0]?.messages)
      expect(request).toContain(lecture.text)
      expect(request).not.toContain(earlierRun.text)
      expect(request).not.toContain(laterRun.text)
      expect((yield* stored(sessionID, { messageID: step.info.id, partID: answerID }))?.metadata).toMatchObject({
        answerSources: [{ materialId: "3" }],
      })
    }),
  )

  it.instance("starts a turn an overflow replayed over from the replayed message", () =>
    Effect.gen(function* () {
      // The student's message written again, unmarked, after the compaction; the model that answers
      // under it never saw the reads before the compaction.
      const turn = yield* compactedTurn()
      const replay = user(turn.sessionID, 5)
      const answer = assistant(turn.sessionID, replay.info.id, 6, [text("A pointer holds an address.")])
      yield* write(turn.question, turn.earlier, turn.compaction, turn.summary, replay, answer)
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: replay.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toEqual([])
      expect(run.visited).not.toContain(turn.earlier.info.id)
    }),
  )

  it.instance("lists no sources under a summary the student asked for", () =>
    Effect.gen(function* () {
      const turn = yield* compactedTurn()
      yield* write(turn.question, turn.earlier, turn.compaction, turn.summary)
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.compaction.info.id,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toEqual([])
    }),
  )

  it.instance("leaves an answer that already carries its sources alone", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const turn = yield* answeredTurn()
      const answer = yield* stored(turn.sessionID, turn.answer)
      yield* sessions.updatePart({ ...answer!, metadata: { answerSources: [] } })
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
      })
      expect(run.calls).toEqual([])
      expect((yield* stored(turn.sessionID, turn.answer))?.metadata).toEqual({ answerSources: [] })
    }),
  )

  it.instance("writes nothing onto an answer removed while its sources were being picked", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const turn = yield* answeredTurn()
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
        duringSelection: sessions
          .removeMessage({ sessionID: turn.sessionID, messageID: turn.answer.messageID })
          .pipe(Effect.asVoid),
      })
      expect(run.calls).toHaveLength(1)
      expect(Exit.isSuccess(run.exit)).toBe(true)
      expect(yield* stored(turn.sessionID, turn.answer)).toBeUndefined()
    }),
  )

  it.instance("leaves no part behind when the answer is removed between its read-back and the write", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const turn = yield* answeredTurn()
      const run = yield* attribute({
        sessionID: turn.sessionID,
        userMessageID: turn.userID,
        replies: ['{"usedSourceRefs":["s1"]}'],
        afterReadBack: sessions
          .removeMessage({ sessionID: turn.sessionID, messageID: turn.answer.messageID })
          .pipe(Effect.asVoid),
      })
      // The part table's foreign key refuses the write, which fails for the caller to log.
      expect(Exit.isFailure(run.exit)).toBe(true)
      expect(yield* stored(turn.sessionID, turn.answer)).toBeUndefined()
    }),
  )
})
