import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { CourseSkillHistory } from "../src/jolli/skill-history"
import { SessionCompaction } from "../src/session/compaction"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import type { EventV2 } from "../src/event"

const reference = {
  type: "course_skill_ref" as const,
  messageId: 42,
  skillId: 8,
  name: "Quiz",
  command: "quiz",
  toolCallId: "call-quiz",
}

test("retains validated references in scalar metadata and keeps the latest invocation per skill", () => {
  const latest = { ...reference, messageId: 43 }
  expect(CourseSkillHistory.merge([[reference], [latest]])).toEqual([latest])
  const metadata = CourseSkillHistory.metadata([reference])
  expect(Object.values(metadata).every((value) => typeof value === "string")).toBe(true)
  expect(CourseSkillHistory.read(metadata)).toEqual([reference])
  expect(CourseSkillHistory.parse(JSON.stringify(reference))).toEqual([reference])
  expect(CourseSkillHistory.parse('{"type":"course_skill_ref"}')).toEqual([])
  expect(CourseSkillHistory.read({ jolliCourseSkillReferences: "invalid" })).toEqual([])
  expect(CourseSkillHistory.merge([[{ ...reference, messageId: 0 }]])).toEqual([])
})

test("compacts with a session-only identity and durably retains skill references outside summary prose", async () => {
  const requests: LLMRequest[] = []
  const published: Array<{ type: string; metadata?: Record<string, unknown> }> = []
  const events = {
    publish: (definition: { type: string }, _data: unknown, options?: { metadata?: Record<string, unknown> }) =>
      Effect.sync(() => {
        published.push({ type: definition.type, metadata: options?.metadata })
      }),
  } as unknown as EventV2.Interface
  const model = Model.make({
    id: "review-model",
    provider: "jolli-openai",
    route: OpenAIChat.route.with({ limits: { context: 200000, output: 1000 } }),
  })
  const compact = SessionCompaction.make({
    events,
    config: [],
    llm: {
      stream: (request) => {
        requests.push(request)
        return Stream.make(LLMEvent.textDelta({ id: "summary", text: "Continue the quiz." }))
      },
    },
  })
  const request = LLM.request({
    model,
    messages: [],
    http: {
      headers: {
        "x-jolli-conversation-id": "ses_review",
        "x-jolli-turn-id": "turn",
        "x-jolli-attempt-id": "attempt",
        "x-jolli-request-id": "attempt:0",
        "x-jolli-step-index": "0",
        "x-jolli-skill-message-ids": "42",
        Authorization: "retained",
      },
    },
  })
  const original = {
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "skill",
        state: {
          status: "completed",
          input: { name: "course:quiz" },
          content: [{ type: "text", text: JSON.stringify(reference) }],
        },
      },
    ],
  } as unknown as SessionMessage.Message
  const oversized = { type: "user", text: "history ".repeat(10000) } as SessionMessage.Message
  expect(
    await Effect.runPromise(
      compact.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_review"),
        model,
        request,
        entries: [
          { seq: 1, message: original },
          { seq: 2, message: oversized },
        ],
      }),
    ),
  ).toBe(true)
  expect(requests[0].http?.headers).toEqual({
    "x-jolli-conversation-id": "ses_review",
    "x-jolli-request-kind": "compaction",
    Authorization: "retained",
  })
  const metadata = published.at(-1)?.metadata
  expect(CourseSkillHistory.read(metadata)).toEqual([reference])
  expect(
    await Effect.runPromise(
      compact.compactAfterOverflow({
        sessionID: SessionSchema.ID.make("ses_review"),
        model,
        request,
        entries: [
          {
            seq: 3,
            message: { type: "compaction", summary: "Earlier quiz", recent: "", metadata } as SessionMessage.Message,
          },
          { seq: 4, message: oversized },
        ],
      }),
    ),
  ).toBe(true)
  expect(CourseSkillHistory.read(published.at(-1)?.metadata)).toEqual([reference])
})

test("remaps copied snapshots without authorizing altered reference metadata", () => {
  const copies = [{ sourceMessageId: reference.messageId, reference: { ...reference, messageId: 1042 } }]
  expect(CourseSkillHistory.remap(reference, copies).messageId).toBe(1042)
  expect(CourseSkillHistory.remap({ ...reference, name: "Changed" }, copies).messageId).toBe(reference.messageId)
})
