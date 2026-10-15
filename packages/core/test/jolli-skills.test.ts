import { describe, expect, test } from "bun:test"
import { Effect, Layer, DateTime } from "effect"
import { LLM, Message, ToolCallPart } from "@opencode-ai/llm"
import { AnthropicMessages } from "@opencode-ai/llm/protocols/anthropic-messages"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { OpenAIResponses } from "@opencode-ai/llm/protocols/openai-responses"
import { OpenAICompatibleChat } from "@opencode-ai/llm/protocols/openai-compatible-chat"
import { Auth, LLMClient } from "@opencode-ai/llm/route"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { JolliSession } from "../src/jolli/session"
import { JolliSkills } from "../src/jolli/skills"
import { AgentV2 } from "../src/agent"
import { SkillGuidance } from "../src/skill/guidance"
import { SystemContext } from "../src/system-context"
import { PermissionV2 } from "../src/permission"
import { ProjectV2 } from "../src/project"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionStore } from "../src/session/store"
import { SkillV2 } from "../src/skill"
import { SkillTool } from "../src/tool/skill"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolIdentity } from "./lib/tool"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { SessionContextEpoch } from "../src/session/context-epoch"
import { SessionTable } from "../src/session/sql"
import { eq } from "drizzle-orm"

const choice = { id: 8, name: "Quiz", command: "quiz", description: "Practice with one question at a time" }
const session = { id: "ses_course_a", metadata: { jolli: { courseId: "7", assistantId: "11" } } }

function gateway(handler: (path: string, request: Request) => Response | Promise<Response>) {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      seen.push(path)
      return handler(path, request)
    },
  })
  const unused = () => Effect.die("Unexpected credential operation")
  const jolli = JolliSession.Service.of({
    current: unused,
    token: unused,
    request: () => Effect.succeed({ origin: server.url.origin, token: "test-token", identity: "student-a" }),
    refused: () => Effect.succeed("renewed-token"),
    signIn: unused,
    signOut: unused,
  })
  return { server, jolli, seen }
}

describe("course skill loading", () => {
  test("reuses a catalog until the next user turn refreshes it", async () => {
    let description = "First version"
    const remote = gateway(() => Response.json([{ ...choice, description }]))
    try {
      expect((await Effect.runPromise(JolliSkills.list(remote.jolli, session)))[0]?.description).toBe("First version")
      description = "Edited version"
      expect((await Effect.runPromise(JolliSkills.list(remote.jolli, session)))[0]?.description).toBe("First version")
      expect(remote.seen).toHaveLength(1)
      expect((await Effect.runPromise(JolliSkills.list(remote.jolli, session, true)))[0]?.description).toBe(
        "Edited version",
      )
      expect(remote.seen).toHaveLength(2)
    } finally {
      await remote.server.stop(true)
    }
  })

  test("shares one in-flight catalog request between concurrent callers", async () => {
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const remote = gateway(async () => {
      ready.resolve()
      await release.promise
      return Response.json([choice])
    })
    try {
      const result = Effect.runPromise(
        Effect.all([JolliSkills.list(remote.jolli, session, true), JolliSkills.list(remote.jolli, session, true)], {
          concurrency: "unbounded",
        }),
      )
      await ready.promise
      release.resolve()
      expect(await result).toEqual([[{ ...choice, toolName: "course:quiz" }], [{ ...choice, toolName: "course:quiz" }]])
      expect(remote.seen).toHaveLength(1)
    } finally {
      release.resolve()
      await remote.server.stop(true)
    }
  })

  test("does not reuse metadata after the authenticated account changes", async () => {
    let identity = "student-a"
    const remote = gateway(() => Response.json(identity === "student-a" ? [choice] : []))
    const jolli = {
      ...remote.jolli,
      request: () => Effect.succeed({ origin: remote.server.url.origin, token: identity, identity }),
    }
    try {
      expect(await Effect.runPromise(JolliSkills.list(jolli, session))).toHaveLength(1)
      identity = "student-b"
      expect(await Effect.runPromise(JolliSkills.list(jolli, session))).toEqual([])
      expect(remote.seen).toHaveLength(2)
    } finally {
      await remote.server.stop(true)
    }
  })

  test("reports a cold catalog failure instead of inventing an empty catalog", async () => {
    const remote = gateway(() => Response.json({}, { status: 503 }))
    try {
      const result = await Effect.runPromise(JolliSkills.list(remote.jolli, session).pipe(Effect.result))
      expect(result._tag).toBe("Failure")
      const requests = remote.seen.length
      expect((await Effect.runPromise(JolliSkills.list(remote.jolli, session).pipe(Effect.result)))._tag).toBe(
        "Failure",
      )
      expect(remote.seen).toHaveLength(requests)
    } finally {
      await remote.server.stop(true)
    }
  })

  test("retains the previous catalog when a refresh times out", async () => {
    const release = Promise.withResolvers<void>()
    let blocked = false
    const remote = gateway(async () => {
      if (blocked) await release.promise
      return Response.json([choice])
    })
    try {
      const first = await Effect.runPromise(JolliSkills.list(remote.jolli, session))
      blocked = true
      expect(await Effect.runPromise(JolliSkills.list(remote.jolli, session, true))).toEqual(first)
      expect(await Effect.runPromise(JolliSkills.list(remote.jolli, session))).toEqual(first)
      expect(remote.seen).toHaveLength(2)
    } finally {
      release.resolve()
      await remote.server.stop(true)
    }
  }, 10000)

  test("invalidates metadata on refusal and never falls back for a previously known session", async () => {
    let status = 200
    const remote = gateway(() => Response.json(status === 200 ? [choice] : {}, { status }))
    try {
      await Effect.runPromise(JolliSkills.list(remote.jolli, session))
      for (const refused of [403, 404, 409]) {
        status = refused
        expect((await Effect.runPromise(JolliSkills.list(remote.jolli, session, true).pipe(Effect.result)))._tag).toBe(
          "Failure",
        )
      }
      expect(remote.seen.some((path) => path.includes("assistant-choices"))).toBe(false)
      expect(
        (await Effect.runPromise(JolliSkills.load(remote.jolli, session, "course:quiz").pipe(Effect.result)))._tag,
      ).toBe("Failure")
      expect(remote.seen.some((path) => path.endsWith("/8"))).toBe(false)
    } finally {
      await remote.server.stop(true)
    }
  })

  test("does not persist spurious context changes on catalog failure and recovery", async () => {
    let status = 200
    let choices = [choice]
    const remote = gateway(() => Response.json(status === 200 ? choices : {}, { status }))
    const layer = AppNodeBuilder.build(LayerNode.group([SkillGuidance.node, Database.node, EventV2.node]), [
      [JolliSession.node, Layer.succeed(JolliSession.Service, remote.jolli)],
      [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed([]) })],
    ])
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const database = yield* Database.Service
          const events = yield* EventV2.Service
          const guidance = yield* SkillGuidance.Service
          const id = SessionV2.ID.make(session.id)
          yield* database.db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* database.db
            .insert(SessionTable)
            .values({
              id,
              project_id: Project.ID.global,
              slug: id,
              directory: "/project",
              title: "Course",
              version: "test",
            })
            .run()
            .pipe(Effect.orDie)
          const agent = AgentV2.Info.empty(AgentV2.ID.make("build"))
          const context = guidance.load({ id: agent.id, info: agent }, session, true)
          yield* SessionContextEpoch.prepare(database.db, events, context, id)
          status = 503
          yield* SessionContextEpoch.prepare(database.db, events, context, id)
          status = 200
          yield* SessionContextEpoch.prepare(database.db, events, context, id)
          expect(
            yield* database.db
              .select()
              .from(EventTable)
              .where(eq(EventTable.type, "session.next.context.updated.1"))
              .all()
              .pipe(Effect.orDie),
          ).toEqual([])
          choices = []
          yield* SessionContextEpoch.prepare(database.db, events, context, id)
          expect(
            yield* database.db
              .select()
              .from(EventTable)
              .where(eq(EventTable.type, "session.next.context.updated.1"))
              .all()
              .pipe(Effect.orDie),
          ).toHaveLength(1)
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      await remote.server.stop(true)
    }
  })

  test("escapes skill metadata without rewriting instruction text", () => {
    const text = JolliSkills.render({
      ...choice,
      name: "Quiz <advanced> & 'tips'",
      command: 'quiz"/><other',
      instructions: "Use <T> in the example.",
      updatedAt: "v1",
    })
    expect(text).toContain('name="course:quiz&quot;/&gt;&lt;other"')
    expect(text).toContain("Quiz &lt;advanced&gt;")
    expect(text).toContain("&amp; &#39;tips&#39;")
    expect(text).toContain("Use <T> in the example.")
  })

  test("publishes the calling session's course catalog through native guidance", async () => {
    const remote = gateway((path) => Response.json(path.includes("ses_course_a") ? [choice] : []))
    const layer = AppNodeBuilder.build(SkillGuidance.node, [
      [JolliSession.node, Layer.succeed(JolliSession.Service, remote.jolli)],
      [
        SkillV2.node,
        Layer.mock(SkillV2.Service, {
          list: () =>
            Effect.succeed([
              {
                name: "course:quiz",
                description: "Local shadow",
                location: AbsolutePath.make("/skills/quiz.md"),
                content: "Local",
              },
              {
                name: "course:other",
                description: "Local impersonation",
                location: AbsolutePath.make("/skills/other.md"),
                content: "Local",
              },
            ]),
        }),
      ],
    ])
    const agent = AgentV2.Info.empty(AgentV2.ID.make("build"))
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const guidance = yield* SkillGuidance.Service
          const first = yield* guidance
            .load({ id: agent.id, info: agent }, session)
            .pipe(Effect.flatMap(SystemContext.initialize))
          expect(first.baseline).toContain("course:quiz")
          expect(first.baseline).toContain(choice.description)
          expect(first.baseline).not.toContain("Local shadow")
          expect(first.baseline).not.toContain("course:other")
          const second = yield* guidance
            .load({ id: agent.id, info: agent }, { ...session, id: "ses_course_b" })
            .pipe(Effect.flatMap(SystemContext.initialize))
          expect(second.baseline).not.toContain("course:quiz")
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      await remote.server.stop(true)
    }
  })

  test("lists only session metadata and never loads bodies during discovery", async () => {
    const remote = gateway((path) => Response.json(path.includes("ses_course_a") ? [choice] : []))
    try {
      expect(await Effect.runPromise(JolliSkills.list(remote.jolli, undefined))).toEqual([])
      expect(remote.seen).toEqual([])
      expect(await Effect.runPromise(JolliSkills.list(remote.jolli, session))).toEqual([
        { ...choice, toolName: "course:quiz" },
      ])
      expect(await Effect.runPromise(JolliSkills.list(remote.jolli, { ...session, id: "ses_course_b" }))).toEqual([])
      expect(remote.seen).toEqual(["/api/agent/convos/ses_course_a/skills", "/api/agent/convos/ses_course_b/skills"])
    } finally {
      await remote.server.stop(true)
    }
  })

  test("discovers a new session through its bound assistant before the first model request", async () => {
    const remote = gateway((path) =>
      path.includes("/convos/")
        ? Response.json({}, { status: 404 })
        : Response.json([
            {
              id: 11,
              name: "Tutor",
              blurb: "",
              icon: "Sparkles",
              accent: 0,
              worksThroughProblems: false,
              answersFromMaterialsOnly: false,
              showCitations: false,
              modelId: "model",
              allowedModelIds: [],
              skills: [choice],
            },
          ]),
    )
    try {
      expect(await Effect.runPromise(JolliSkills.list(remote.jolli, session))).toEqual([
        { ...choice, toolName: "course:quiz" },
      ])
      expect(remote.seen).toContain("/api/courses/7/assistant-choices")
      expect(
        await Effect.runPromise(
          JolliSkills.list(remote.jolli, { ...session, metadata: { jolli: { courseId: "7", assistantId: "99" } } }),
        ),
      ).toEqual([])
    } finally {
      await remote.server.stop(true)
    }
  })

  test("renews a refused credential and loads the body only on invocation", async () => {
    const remote = gateway((path, request) => {
      if (request.headers.get("authorization") === "Bearer test-token") return Response.json({}, { status: 401 })
      return Response.json(
        path.endsWith("/8") ? { ...choice, instructions: "Ask one question.", updatedAt: "v1" } : [choice],
      )
    })
    try {
      const loaded = await Effect.runPromise(JolliSkills.load(remote.jolli, session, "course:quiz"))
      expect(loaded.instructions).toBe("Ask one question.")
      expect(JolliSkills.render(loaded)).not.toContain("Base directory")
      expect(remote.seen.filter((path) => path.endsWith("/8"))).toHaveLength(2)
    } finally {
      await remote.server.stop(true)
    }
  })

  test("refuses a skill absent from this session without querying its body", async () => {
    const remote = gateway(() => Response.json([]))
    try {
      const result = await Effect.runPromise(
        JolliSkills.load(remote.jolli, session, "course:other").pipe(Effect.result),
      )
      expect(result._tag).toBe("Failure")
      expect(remote.seen).toEqual(["/api/agent/convos/ses_course_a/skills"])
    } finally {
      await remote.server.stop(true)
    }
  })

  test("returns native skill results whose earlier content survives later edits", async () => {
    let instructions = "Ask one question."
    let permitted = true
    const remote = gateway((path) =>
      Response.json(path.endsWith("/8") ? { ...choice, instructions, updatedAt: "v1" } : [choice]),
    )
    await using directory = await tmpdir()
    const info = SessionV2.Info.make({
      ...session,
      id: SessionV2.ID.make(session.id),
      projectID: ProjectV2.ID.make("project-course-skills"),
      title: "Course skills",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: { directory: AbsolutePath.make(directory.path) },
    })
    const layer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]), [
      [JolliSession.node, Layer.succeed(JolliSession.Service, remote.jolli)],
      [SessionStore.node, Layer.mock(SessionStore.Service, { get: () => Effect.succeed(info) })],
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: () => (permitted ? Effect.void : Effect.fail(new PermissionV2.BlockedError({ rules: [] }))),
        }),
      ],
      [SkillV2.node, Layer.mock(SkillV2.Service, { list: () => Effect.succeed([]) })],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ])
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const input = {
            sessionID: info.id,
            ...toolIdentity,
            call: { type: "tool-call" as const, id: "course-call", name: "skill", input: { name: "course:quiz" } },
          }
          const first = yield* settleTool(registry, input)
          const snapshot = JSON.stringify(first.output)
          expect(first.result).toMatchObject({ type: "text" })
          expect(snapshot).toContain("Ask one question.")
          instructions = "Ask ten questions."
          const second = yield* settleTool(registry, { ...input, call: { ...input.call, id: "course-call-two" } })
          expect(JSON.stringify(second.output)).toContain("Ask ten questions.")
          expect(JSON.stringify(first.output)).toBe(snapshot)
          const requests = remote.seen.length
          permitted = false
          const denied = yield* settleTool(registry, { ...input, call: { ...input.call, id: "course-call-denied" } })
          expect(denied.result.type).toBe("error")
          expect(remote.seen).toHaveLength(requests)
        }).pipe(Effect.provide(layer), Effect.scoped),
      )
    } finally {
      await remote.server.stop(true)
    }
  })

  test("replays the same saved body through all supported text protocols", async () => {
    const body = JolliSkills.render({ ...choice, instructions: "Ask one question.", updatedAt: "v1" })
    for (const route of [
      AnthropicMessages.route,
      OpenAIChat.route,
      OpenAIResponses.route,
      OpenAICompatibleChat.route,
    ]) {
      const model = route
        .with({ endpoint: { baseURL: "https://model.invalid/v1" }, auth: Auth.bearer("test") })
        .model({ id: "test", provider: "test" })
      const prepared = await Effect.runPromise(
        LLMClient.prepare(
          LLM.request({
            model,
            messages: [
              Message.user("Use course:quiz"),
              Message.assistant([
                ToolCallPart.make({ id: "call-quiz", name: "skill", input: { name: "course:quiz" } }),
              ]),
              Message.tool({ id: "call-quiz", name: "skill", result: body }),
              Message.user("My answer is O(log n)."),
            ],
          }),
        ),
      )
      expect(JSON.stringify(prepared.body)).toContain("Ask one question.")
      expect(JSON.stringify(prepared.body)).toContain("call-quiz")
    }
  })
})
