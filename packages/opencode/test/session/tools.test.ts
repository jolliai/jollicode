import { expect } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
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
import { asSchema } from "ai"
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
                  return { title: "timing", metadata: {}, output: "done" }
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
    const execute = tools.timing.execute
    if (!execute) throw new Error("timing tool is missing execute")

    yield* Effect.promise(() =>
      execute(
        {},
        {
          toolCallId: callID,
          abortSignal: new AbortController().signal,
          messages: [],
        },
      ),
    )

    expect(updates).toEqual([100, 100])
    expect(state.state.status).toBe("running")
    if (state.state.status === "running") {
      expect(state.state.time.start).toBe(100)
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
