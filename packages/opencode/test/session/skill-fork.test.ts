import { Jolli } from "@opencode-ai/schema/jolli"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "../../src/session/session"
import { MessageID, PartID } from "../../src/session/schema"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { testEffect } from "../lib/effect"

const reference = {
  type: "course_skill_ref" as const,
  messageId: 42,
  skillId: 8,
  name: "Quiz",
  command: "quiz",
  toolCallId: "call-quiz",
}
const jolli = Layer.effect(
  JolliSession.Service,
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: async (request) => {
            const body = Schema.decodeUnknownSync(
              Schema.Struct({ references: Schema.Array(Jolli.CourseSkillReference) }),
            )(await request.json())
            if (body.references.some((item) => item.command === "offline"))
              return Response.json({ error: "unavailable" }, { status: 503 })
            return Response.json(
              body.references.map((item) => ({
                sourceMessageId: item.messageId,
                reference: { ...item, messageId: item.messageId + 1000 },
              })),
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const unused = () => Effect.die("Unexpected credential operation")
    return JolliSession.Service.of({
      current: unused,
      token: unused,
      signIn: unused,
      signOut: unused,
      refused: unused,
      request: () => Effect.succeed({ origin: server.url.origin, token: "test-token", identity: "student" }),
    })
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [JolliSession.node, jolli],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const seedSkillCall = Effect.fn("test.seedSkillCall")(function* (saved: typeof reference) {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({ metadata: { jolli: { courseId: "7", assistantId: "11" } } })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  } satisfies SessionV1.User)
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "assistant",
    parentID: user.id,
    time: { created: 2 },
    agent: "build",
    mode: "build",
    modelID: ModelV2.ID.make("model"),
    providerID: ProviderV2.ID.make("test"),
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies SessionV1.Assistant)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: assistant.id,
    type: "tool",
    tool: "skill",
    callID: "call-quiz",
    state: {
      status: "completed",
      input: { name: "course:quiz" },
      title: "Quiz",
      output: JSON.stringify(saved),
      metadata: {},
      time: { start: 2, end: 3 },
    },
  })
  return { parent, user }
})

it.instance("forks saved course references without changing the original transcript", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { parent, user } = yield* seedSkillCall(reference)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: parent.id,
      messageID: user.id,
      type: "compaction",
      auto: true,
      courseSkillReferences: [reference],
    })
    const fork = yield* sessions.fork({ sessionID: parent.id })
    const copied = yield* sessions.messages({ sessionID: fork.id })
    const parts = copied.flatMap((message) => message.parts)
    const tool = parts.find((part) => part.type === "tool")
    expect(tool?.type === "tool" && tool.state.status === "completed" && JSON.parse(tool.state.output).messageId).toBe(
      1042,
    )
    expect(parts.find((part) => part.type === "compaction")?.courseSkillReferences?.[0].messageId).toBe(1042)
    const original = (yield* sessions.messages({ sessionID: parent.id }))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool")
    expect(
      original?.type === "tool" && original.state.status === "completed" && JSON.parse(original.state.output).messageId,
    ).toBe(42)
  }),
)

it.instance("forks without copying snapshots when Jolli cannot copy them", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { parent } = yield* seedSkillCall({ ...reference, command: "offline" })
    const fork = yield* sessions.fork({ sessionID: parent.id })
    const tool = (yield* sessions.messages({ sessionID: fork.id }))
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool")
    expect(tool?.type === "tool" && tool.state.status === "completed" && JSON.parse(tool.state.output).messageId).toBe(
      42,
    )
  }),
)
