import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect, Layer, Option, Stream } from "effect"
import { Provider } from "@/provider/provider"
import { CourseSources } from "@/session/course-sources"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"

const sessionID = SessionID.make("ses_sources")
const userID = MessageID.ascending()
const lecture = { kind: "material", materialId: "3", title: "Lecture 4", text: "A pointer holds an address." }

function turn(over: { error?: unknown; evidence?: unknown[] } = {}) {
  const user = {
    info: { id: userID, sessionID, role: "user", time: { created: 1 }, system: "the student's own system text" },
    parts: [],
  }
  const assistantID = MessageID.ascending()
  const assistant = {
    info: {
      id: assistantID,
      sessionID,
      role: "assistant",
      parentID: userID,
      providerID: ProviderV2.ID.make("jolli-anthropic"),
      modelID: ModelV2.ID.make("sonnet"),
      time: { created: 2, completed: 3 },
      ...(over.error ? { error: over.error } : {}),
    },
    parts: [
      {
        id: "prt_read",
        sessionID,
        messageID: assistantID,
        type: "tool",
        callID: "call_read",
        tool: "jolliedu_get_remote_material_content",
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: { evidence: over.evidence ?? [lecture] },
          time: { start: 2, end: 3 },
        },
      },
      { id: "prt_answer", sessionID, messageID: assistantID, type: "text", text: "A pointer holds an address." },
    ],
  }
  return [user, assistant] as unknown as SessionV1.WithParts[]
}

function harness(replies: string[], messages = turn(), over: { removed?: boolean } = {}) {
  const updated: SessionV1.Part[] = []
  const calls: LLM.StreamInput[] = []
  const visited: string[] = []
  const layer = Layer.mergeAll(
    Layer.mock(Session.Service)({
      findMessage: (_sessionID, predicate) =>
        Effect.sync(() => {
          for (const message of [...messages].reverse()) {
            visited.push(message.info.id)
            if (predicate(message)) return Option.some(message)
          }
          return Option.none()
        }),
      getPart: (input) =>
        Effect.sync(() =>
          over.removed
            ? undefined
            : messages.flatMap((message) => message.parts).find((part) => part.id === input.partID),
        ),
      updatePart: (part) => Effect.sync(() => (updated.push(part), part)),
    }),
    Layer.mock(Provider.Service)({ getModel: () => Effect.succeed({ id: "sonnet" } as unknown as Provider.Model) }),
    Layer.mock(LLM.Service)({
      stream: (input) => {
        calls.push(input)
        const text = replies[calls.length - 1] ?? ""
        return Stream.make(LLMEvent.textDelta({ id: "t", text }), LLMEvent.finish({ reason: "stop" }))
      },
    }),
  )
  const run = (userMessageID: MessageID = userID) =>
    Effect.runPromise(CourseSources.attribute({ sessionID, userMessageID }).pipe(Effect.provide(layer)))
  return { run, updated, calls, visited }
}

/**
 * A turn auto-compaction cut in two: the student's message, a step that read the lecture, the
 * compaction message and its summary, then the synthetic "continue" message and the answer under it.
 */
function compactedTurn() {
  const [user, before] = turn()
  const assistant = (id: MessageID, parentID: MessageID, parts: unknown[], over: Record<string, unknown> = {}) => ({
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID,
      providerID: ProviderV2.ID.make("jolli-anthropic"),
      modelID: ModelV2.ID.make("sonnet"),
      time: { created: 2, completed: 3 },
      ...over,
    },
    parts,
  })
  const earlier = { ...before, parts: before!.parts.filter((part) => part.type === "tool") }
  const compactionID = MessageID.ascending()
  const compaction = {
    info: { id: compactionID, sessionID, role: "user", time: { created: 4 } },
    parts: [{ id: "prt_compaction", sessionID, messageID: compactionID, type: "compaction", auto: true }],
  }
  const summaryID = MessageID.ascending()
  const summary = assistant(
    summaryID,
    compactionID,
    [{ id: "prt_summary", sessionID, messageID: summaryID, type: "text", text: "We read Lecture 4." }],
    { summary: true },
  )
  const continueID = MessageID.ascending()
  const carryOn = {
    info: { id: continueID, sessionID, role: "user", time: { created: 5 } },
    parts: [
      {
        id: "prt_continue",
        sessionID,
        messageID: continueID,
        type: "text",
        text: "Continue if you have next steps.",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ],
  }
  const answerID = MessageID.ascending()
  const answer = assistant(answerID, continueID, [
    { id: "prt_answer", sessionID, messageID: answerID, type: "text", text: "A pointer holds an address." },
  ])
  return {
    messages: [user, earlier, compaction, summary, carryOn, answer] as unknown as SessionV1.WithParts[],
    continueID,
  }
}

describe("CourseSources.attribute", () => {
  test("writes the sources the selection picked onto the answer's text part", async () => {
    const h = harness(['{"usedSourceRefs":["s1"]}'])
    await h.run()
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]).toMatchObject({
      id: "prt_answer",
      metadata: { answerSources: [{ kind: "material", materialId: "3", title: "Lecture 4" }] },
    })
  })

  test("briefs the selection alone, without the course prompt, tools or the student's system text", async () => {
    const h = harness(['{"usedSourceRefs":[]}'])
    await h.run()
    const input = h.calls[0]
    expect(input?.system).toEqual([])
    expect(input?.tools).toEqual({})
    expect(input?.agent.prompt).toContain("Select only sources whose supplied evidence directly supports")
    expect(input?.user.system).toBeUndefined()
    expect(h.updated[0]).toMatchObject({ metadata: { answerSources: [] } })
  })

  test("corrects an unreadable reply once, telling the model what was wrong", async () => {
    const h = harness(["the first one", '{"usedSourceRefs":["s1"]}'])
    await h.run()
    expect(h.calls).toHaveLength(2)
    const retry = h.calls[1]?.messages ?? []
    expect(retry.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(JSON.stringify(retry[2])).toContain("the reply contained no complete JSON object")
    expect(h.updated).toHaveLength(1)
  })

  test("writes nothing when the corrected retry fails too", async () => {
    const h = harness(["no", "still no"])
    await h.run()
    expect(h.calls).toHaveLength(2)
    expect(h.updated).toEqual([])
  })

  test("asks nothing when the turn's tools returned no evidence", async () => {
    const h = harness(['{"usedSourceRefs":["s1"]}'], turn({ evidence: [] }))
    await h.run()
    expect(h.calls).toEqual([])
    expect(h.updated).toEqual([])
  })

  test("asks nothing about a turn that failed", async () => {
    const h = harness(['{"usedSourceRefs":["s1"]}'], turn({ error: { name: "APIError", data: { message: "down" } } }))
    await h.run()
    expect(h.calls).toEqual([])
  })

  test("reads the session back only as far as the turn's own message", async () => {
    const olderID = MessageID.ascending()
    const older = { info: { id: olderID, sessionID, role: "user", time: { created: 0 } }, parts: [] }
    const h = harness(['{"usedSourceRefs":["s1"]}'], [older as unknown as SessionV1.WithParts, ...turn()])
    await h.run()
    expect(h.updated).toHaveLength(1)
    expect(h.visited).not.toContain(olderID)
  })

  test("judges a turn auto-compaction cut in two whole, from the materials read before it", async () => {
    const { messages, continueID } = compactedTurn()
    const h = harness(['{"usedSourceRefs":["s1"]}'], messages)
    await h.run(continueID)
    expect(JSON.stringify(h.calls[0]?.messages)).toContain(lecture.text)
    expect(JSON.stringify(h.calls[0]?.messages)).not.toContain("We read Lecture 4.")
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]).toMatchObject({ id: "prt_answer", metadata: { answerSources: [{ materialId: "3" }] } })
  })

  test("lists no sources under a summary the student asked for", async () => {
    const { messages } = compactedTurn()
    const [user, earlier, compaction, summary] = messages
    const h = harness(['{"usedSourceRefs":["s1"]}'], [user!, earlier!, compaction!, summary!])
    await h.run(compaction!.info.id)
    expect(h.calls).toEqual([])
    expect(h.updated).toEqual([])
  })

  test("leaves an answer that already carries its sources alone", async () => {
    const messages = turn()
    const answer = messages[1]!.parts.find((part) => part.type === "text") as SessionV1.TextPart
    answer.metadata = { answerSources: [] }
    const h = harness(['{"usedSourceRefs":["s1"]}'], messages)
    await h.run()
    expect(h.calls).toEqual([])
    expect(h.updated).toEqual([])
  })

  test("writes nothing onto an answer removed while its sources were being picked", async () => {
    const h = harness(['{"usedSourceRefs":["s1"]}'], turn(), { removed: true })
    await h.run()
    expect(h.calls).toHaveLength(1)
    expect(h.updated).toEqual([])
  })
})
