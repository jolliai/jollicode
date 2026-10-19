import { describe, expect } from "bun:test"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Effect, Layer, Schema } from "effect"
import { asSchema, streamText } from "ai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { testEffect } from "../lib/effect"

const callID = "call-test"
const sessionID = SessionID.make("ses_test")
const messageID = MessageID.ascending()
const partID = PartID.ascending()

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

const model = {
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model" },
} as Provider.Model

function fakeMcp() {
  return MCP.Service.of({
    tools: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
  } as Partial<MCP.Interface> as MCP.Interface)
}

const fakePlugin = Plugin.Service.of({
  init: () => Effect.void,
  list: () => Effect.succeed([]),
  trigger: (_name, _input, output) => Effect.succeed(output),
} satisfies Plugin.Interface)

const fakePermission = Permission.Service.of({
  ask: () => Effect.void,
  reply: () => Effect.void,
  list: () => Effect.succeed([]),
} satisfies Permission.Interface)

const fakeTruncate = Truncate.Service.of({
  cleanup: () => Effect.void,
  write: () => Effect.succeed("output.txt"),
  output: (text: string) => Effect.succeed({ content: text, truncated: false }),
  limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
} satisfies Truncate.Interface)

function createLayer(plugin: Plugin.Interface = fakePlugin, mcp: MCP.Interface = fakeMcp()) {
  return Layer.mergeAll(
    Layer.succeed(Plugin.Service, plugin),
    Layer.succeed(Permission.Service, fakePermission),
    Layer.succeed(MCP.Service, mcp),
    Layer.succeed(Truncate.Service, fakeTruncate),
    RuntimeFlags.layer(),
    Layer.succeed(
      ToolRegistry.Service,
      ToolRegistry.Service.of({
        ids: () => Effect.succeed(["timing"]),
        all: () => Effect.succeed([]),
        named: () => Effect.die("unused"),
        tools: () =>
          Effect.succeed([
            {
              id: "timing",
              description: "updates metadata more than once",
              parameters: Schema.Struct({}),
              jsonSchema: { type: "object", properties: {} },
              execute: (_args, ctx) =>
                Effect.gen(function* () {
                  yield* ctx.metadata({ metadata: { output: "first" } })
                  yield* ctx.metadata({ metadata: { output: "second" } })
                  return { title: "timing", metadata: { sourceIndex: ctx.extra?.codingToolIndex }, output: "done" }
                }),
            } satisfies Tool.Def,
          ]),
      }),
    ),
  )
}

const it = testEffect(createLayer())

it.effect("preserves running tool start time across metadata updates", () =>
  Effect.gen(function* () {
    const state: SessionV1.ToolPart = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      tool: "timing",
      callID,
      state: {
        status: "running",
        input: {},
        time: { start: 100 },
      },
    }
    const updates: number[] = []
    const processor = {
      message: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.ascending(),
        agent: "build",
        mode: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      updateToolCall: (_toolCallID, update) =>
        Effect.sync(() => {
          const next = update(state)
          state.state = next.state
          if (state.state.status === "running") updates.push(state.state.time.start)
          return state
        }),
      completeToolCall: () => Effect.void,
    } satisfies Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">

    const { tools } = yield* SessionTools.resolve({
      agent,
      model,
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    // One stream step: the AI SDK passes the same `messages` array for every call in it.
    const messages: never[] = []
    const options = (toolCallId: string) => ({ toolCallId, messages, abortSignal: new AbortController().signal })
    yield* Effect.promise(async () => {
      await tools.timing.onInputStart?.(options("call-first"))
      await tools.timing.onInputStart?.(options(callID))
      await tools.timing.onInputStart?.(options(callID))
    })
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    const result = yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(result).toMatchObject({ metadata: { sourceIndex: 1 } })
    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
    }
  }),
)

it.effect("assigns per-response source ordinals through real Gemini parallel tool execution", () =>
  Effect.gen(function* () {
    const resolved = yield* SessionTools.resolve({
      agent,
      model,
      session: {
        id: sessionID,
        slug: "test",
        projectID: ProjectV2.ID.make("project-test"),
        directory: "/tmp",
        title: "Test",
        version: "test",
        time: { created: 1, updated: 1 },
        permission: [],
      },
      processor: {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        },
        updateToolCall: () => Effect.succeed(undefined),
        completeToolCall: () => Effect.void,
      },
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    })
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () =>
            new Response(
              `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [0, 1].map(() => ({ functionCall: { name: "timing", args: {} } })) }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const google = createGoogleGenerativeAI({ apiKey: "test-key", baseURL: server.url.origin })
    const stream = () =>
      Effect.promise(async () => {
        const result = streamText({
          model: google("gemini-2.5-flash"),
          tools: resolved.tools,
          prompt: "Call timing twice",
          maxRetries: 0,
        })
        await result.consumeStream()
        return result.toolResults
      })
    // The processor retries a failed stream with the same tools; its ordinals must start over.
    for (const outputs of [yield* stream(), yield* stream()]) {
      expect(outputs).toHaveLength(2)
      expect(outputs.map((output) => output.output)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ metadata: { sourceIndex: 0 } }),
          expect.objectContaining({ metadata: { sourceIndex: 1 } }),
        ]),
      )
    }
  }),
)

it.effect("applies tool definition hooks to MCP tools before exposing their schemas", () =>
  Effect.gen(function* () {
    let calledArguments: Record<string, unknown> | undefined
    const client = {
      callTool: async (request: { arguments?: Record<string, unknown> }) => {
        calledArguments = request.arguments
        return { content: [{ type: "text" as const, text: "ok" }] }
      },
    }
    const mcp = MCP.Service.of({
      tools: () =>
        Effect.succeed({
          jolliedu_get_conversation_context: {
            def: {
              name: "get_conversation_context",
              description: "course context",
              inputSchema: {
                type: "object" as const,
                properties: {
                  courseId: { type: "number" },
                  assistantId: { type: "number" },
                },
                required: ["courseId", "assistantId"],
              },
            },
            client,
            server: "jolliedu",
          },
        }),
      clients: () => Effect.succeed({}),
    } as unknown as Partial<MCP.Interface> as MCP.Interface)
    const plugin = Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (name, _input, output) =>
        Effect.sync(() => {
          if (name === "tool.definition") {
            const definition = output as {
              parameters: { properties: Record<string, unknown>; required: string[] }
            }
            definition.parameters = { properties: {}, required: [] }
          }
          if (name === "tool.execute.before") {
            const execution = output as { args: Record<string, unknown> }
            Object.assign(execution.args, { courseId: 7, assistantId: 12 })
          }
          return output
        }),
    } satisfies Plugin.Interface)

    const serviceLayer = createLayer(plugin, mcp)
    const result = yield* SessionTools.resolve({
      agent,
      model,
      // Bound to a course, which is what makes the course tool worth offering at all.
      session: {
        id: sessionID,
        permission: [],
        metadata: { jolli: { courseId: "7", assistantId: "12" } },
      } as unknown as Session.Info,
      processor: {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        },
        updateToolCall: () => Effect.die("unused"),
        completeToolCall: () => Effect.void,
      } as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }).pipe(Effect.provide(serviceLayer))

    const courseTool = result.tools.jolliedu_get_conversation_context
    expect(courseTool).toBeDefined()
    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(courseTool!.inputSchema).jsonSchema))
    expect(schema.properties).toEqual({})
    expect(schema.required).toEqual([])

    yield* Effect.promise(() =>
      courseTool!.execute!(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )
    expect(calledArguments).toEqual({ courseId: 7, assistantId: 12 })
  }),
)

it.effect("does not offer the course tools to a session with no course binding, keeping the others", () =>
  Effect.gen(function* () {
    const client = { callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }) }
    const definition = (name: string) => ({
      def: { name, description: name, inputSchema: { type: "object" as const, properties: {} } },
      client,
      server: "jolliedu",
    })
    const mcp = MCP.Service.of({
      tools: () =>
        Effect.succeed({
          jolliedu_get_conversation_context: definition("get_conversation_context"),
          jolliedu_list_all_materials_in_remote_course: definition("list_all_materials_in_remote_course"),
          jolliedu_list_user_attachments: definition("list_user_attachments"),
        }),
      clients: () => Effect.succeed({}),
    } as unknown as Partial<MCP.Interface> as MCP.Interface)
    const plugin = Plugin.Service.of({
      init: () => Effect.void,
      list: () => Effect.succeed([]),
      trigger: (_name, _input, output) => Effect.succeed(output),
    } satisfies Plugin.Interface)

    const result = yield* SessionTools.resolve({
      agent,
      model,
      // Every call to a course tool here would be refused for the missing binding, a wasted turn each.
      session: { id: sessionID, permission: [] } as unknown as Session.Info,
      processor: {
        message: {
          id: messageID,
          sessionID,
          role: "assistant",
          parentID: MessageID.ascending(),
          agent: "build",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: 1 },
        },
        updateToolCall: () => Effect.die("unused"),
        completeToolCall: () => Effect.void,
      } as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }).pipe(Effect.provide(createLayer(plugin, mcp)))

    expect(result.tools.jolliedu_get_conversation_context).toBeUndefined()
    expect(result.tools.jolliedu_list_all_materials_in_remote_course).toBeUndefined()
    expect(result.tools.jolliedu_list_user_attachments).toBeDefined()
  }),
)

describe("the hand-in tools", () => {
  const handInDefinition = {
    id: "jolli_submit_task",
    description: "hands a task in",
    parameters: Schema.Struct({}),
    jsonSchema: { type: "object", properties: {} },
    execute: (_args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "jolli_submit_task",
          patterns: ["Lab 4 · Task 2"],
          always: ["task"],
          metadata: {},
        })
        return { title: "", metadata: {}, output: "handed in" }
      }),
  } satisfies Tool.Def

  function handInLayer(asked: PermissionV1.Ruleset[]) {
    return Layer.mergeAll(
      Layer.succeed(Plugin.Service, fakePlugin),
      Layer.succeed(
        Permission.Service,
        Permission.Service.of({
          ask: (input) => Effect.sync(() => void asked.push(input.ruleset)),
          reply: () => Effect.void,
          list: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(MCP.Service, fakeMcp()),
      Layer.succeed(Truncate.Service, fakeTruncate),
      RuntimeFlags.layer(),
      Layer.succeed(
        ToolRegistry.Service,
        ToolRegistry.Service.of({
          ids: () => Effect.succeed([handInDefinition.id]),
          all: () => Effect.succeed([]),
          named: () => Effect.die("unused"),
          tools: () => Effect.succeed([handInDefinition]),
        }),
      ),
    )
  }

  const resolveFor = (metadata: Record<string, unknown> | undefined, asked: PermissionV1.Ruleset[]) =>
    SessionTools.resolve({
      agent,
      model,
      session: {
        id: sessionID,
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        metadata,
      } as unknown as Session.Info,
      processor: {
        message: { id: messageID } as SessionV1.Assistant,
        updateToolCall: () => Effect.die("unused"),
        completeToolCall: () => Effect.void,
      } as Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as never,
    }).pipe(Effect.provide(handInLayer(asked)))

  const TASK = { jolliTask: { sessionID, assignmentId: "40", partId: "42" } }

  /** ⚠ A PLAIN CHAT, A FORK AND A CHILD HAVE NO TASK THE GATEWAY BOUND TO THEM. */
  it.effect("are not offered in a session no task started, a fork's copy included", () =>
    Effect.gen(function* () {
      expect((yield* resolveFor(undefined, [])).tools.jolli_submit_task).toBeUndefined()
      const copy = { jolliTask: { ...TASK.jolliTask, sessionID: "ses_original" } }
      expect((yield* resolveFor(copy, [])).tools.jolli_submit_task).toBeUndefined()
    }),
  )

  /** ⚠ AN AGENT AND A SESSION THAT ALLOW EVERYTHING STILL DO NOT ANSWER FOR THE STUDENT. */
  it.effect("are offered in the task's session, and always asked whatever else allows", () =>
    Effect.gen(function* () {
      const asked: PermissionV1.Ruleset[] = []
      const result = yield* resolveFor(TASK, asked)
      const handIn = result.tools.jolli_submit_task
      expect(handIn).toBeDefined()
      yield* Effect.promise(() =>
        Promise.resolve(
          handIn!.execute!({}, { toolCallId: "call-hand-in", messages: [], abortSignal: new AbortController().signal }),
        ),
      )
      const ruleset = asked[0] ?? []
      expect(Permission.evaluate("jolli_submit_task", "Lab 4 · Task 2", ruleset).action).toBe("ask")
      expect(Permission.evaluate("jolli_turn_in_assignment", "Lab 4", ruleset).action).toBe("ask")
      expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
    }),
  )
})
