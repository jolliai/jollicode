import { describe, expect, setSystemTime, spyOn, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { PluginInput } from "@opencode-ai/plugin"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Context, Effect, Layer, Logger } from "effect"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { MCP } from "@/mcp"
import { JolliMcpCall } from "@/mcp/jolli-call"
import { Plugin } from "@/plugin"
import { JolliCourseChatPlugin, courseMemberDefinitionFor } from "@/plugin/jolli-course-chat"
import { JolliClosedAssistants } from "@opencode-ai/core/jolli/closed-assistants"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Session } from "@/session/session"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

/**
 * A bridge over a session that only answers reads. The plugin keeps nothing in the session, so a write
 * to its metadata would be a regression, and it fails the test that makes it.
 *
 * Hand-made on purpose: these tests pin the hooks' own logic. Whether the production bridge can
 * reach `Session` at all is a property of `Plugin.node`, which this bridge bypasses, so the plugin
 * layer test at the end of this file covers it instead.
 */
function sessionBridge(metadata?: Record<string, unknown>) {
  let reads = 0
  const unused = () => {
    throw new Error("the course chat plugin should not need this bridge method")
  }
  const bridge = {
    promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(
            Layer.mock(Session.Service)({
              get: () =>
                Effect.sync(() => {
                  reads += 1
                  return { metadata } as Session.Info
                }),
              setMetadata: () => Effect.die(new Error("the course chat plugin must not write session metadata")),
            }),
          ),
        ) as Effect.Effect<A, E>,
      ),
    fork: unused,
    run: unused,
    bind: unused,
  } as unknown as EffectBridge.Shape
  return { bridge, reads: () => reads }
}

const BOUND = { jolli: { courseId: "7", assistantId: "12" } }

type MemberDefinition = { description: string; parameters: Record<string, unknown> }

/**
 * Resolves once `asked` holds. The plugin asks for a member definition only after it has read the signed-in
 * account, so a read is requested a few ticks after the hook is called, not as it is called.
 */
async function until(asked: () => boolean) {
  while (!asked()) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The member tool's definition the hooks give the model for a session, as one model step resolves it. */
async function memberTool(
  hooks: Awaited<ReturnType<typeof plugin>>["hooks"],
  sessionID = "ses_members",
  turnID?: string,
) {
  const output = { description: "Listed", parameters: {} as Record<string, unknown> }
  await hooks["tool.definition"]({ toolID: JolliSources.MEMBERS_TOOL, sessionID, turnID }, output)
  return output
}

function page(body: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify(body) }], title: "List", output: "", metadata: undefined }
}

async function expectCursorRejected(call: Promise<void>) {
  const error = await call.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain("not returned")
}

async function plugin(
  metadata?: Record<string, unknown>,
  options: {
    citationsShown?: (sessionID: string) => Promise<boolean | undefined>
    memberDefinition?: (sessionID: string) => Promise<MemberDefinition | undefined>
    account?: () => Promise<{ ok: true; id?: string } | { ok: false }>
  } = {},
) {
  const session = sessionBridge(metadata)
  const hooks = await JolliCourseChatPlugin({} as PluginInput, {
    bridge: session.bridge,
    citationsShown: async () => true,
    // Signed out: one account for every session these tests make.
    account: async () => ({ ok: true }),
    ...options,
  })
  const before = hooks["tool.execute.before"]
  const after = hooks["tool.execute.after"]
  const definition = hooks["tool.definition"]
  if (!before || !after || !definition) throw new Error("Course chat hooks must be present")
  return {
    hooks: { ...hooks, "tool.execute.before": before, "tool.execute.after": after, "tool.definition": definition },
    reads: session.reads,
  }
}

/** A bridge whose session read fails, as a storage fault would make it. */
function failingSessionBridge() {
  return {
    promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provide(Layer.mock(Session.Service)({ get: () => Effect.die(new Error("database is locked")) })),
        ) as Effect.Effect<A, E>,
      ),
  } as unknown as EffectBridge.Shape
}

describe("plugin.jolli-course-chat", () => {
  test.each([false, true])("logs an unsupported member definition (describeOnly: %s)", async (supportsDescribe) => {
    const warnings: unknown[] = []
    let calls = 0
    const bridge = await Effect.runPromise(
      EffectBridge.make().pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Session.Service, { get: () => Effect.succeed({ metadata: BOUND } as unknown as Session.Info) }),
            Layer.mock(MCP.Service, {
              tools: () =>
                Effect.succeed({
                  [JolliSources.MEMBERS_TOOL]: {
                    def: {
                      name: "get_course_members",
                      inputSchema: {
                        type: "object",
                        properties: Object.fromEntries(supportsDescribe ? [["describeOnly", { type: "boolean" }]] : []),
                      },
                    },
                    client: {
                      callTool: async () => {
                        calls += 1
                        return { content: [{ type: "text", text: "{}" }] }
                      },
                    } as unknown as MCP.McpTool["client"],
                    server: "jolliedu",
                  },
                }),
            }),
            Logger.layer([
              Logger.make((options) => {
                warnings.push(options.message)
              }),
            ]),
          ),
        ),
      ),
    )
    expect(await courseMemberDefinitionFor(bridge, "ses_members")).toBeUndefined()
    expect(calls).toBe(supportsDescribe ? 1 : 0)
    expect(JSON.stringify(warnings)).toContain(
      supportsDescribe ? "unsupported member tool definition" : "does not support describeOnly",
    )
  })

  test("registers the server-authorized member view for the current session", async () => {
    for (const staff of [false, true]) {
      const { hooks } = await plugin(BOUND, {
        memberDefinition: async (sessionID) => {
          expect(sessionID).toBe("ses_members")
          return {
            description: staff ? "Search enrolled students" : "Read instructors and enrollment count",
            parameters: {
              type: "object",
              properties: staff ? { query: { type: "string" } } : {},
              additionalProperties: false,
            },
          }
        },
      })
      const output = { description: "Transport schema", parameters: { type: "object", properties: { query: {} } } }
      await hooks["tool.definition"]({ toolID: "jolliedu_get_course_members", sessionID: "ses_members" }, output)
      expect(output.description).toBe(staff ? "Search enrolled students" : "Read instructors and enrollment count")
      expect("query" in output.parameters.properties).toBe(staff)
    }
  })

  test("falls back to a summary-only member tool after a failed read, and asks again only after a rest", async () => {
    const answer = Promise.withResolvers<MemberDefinition>()
    let reads = 0
    const { hooks } = await plugin(BOUND, {
      memberDefinition: () => {
        reads += 1
        return reads === 1 ? Promise.reject(new Error("offline")) : answer.promise
      },
    })
    try {
      setSystemTime(new Date("2026-10-27T09:00:00Z"))
      const fallback = await memberTool(hooks)
      expect(fallback.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false })
      expect(fallback.description).not.toContain("roster")

      // A server that keeps failing is not asked again on every step.
      await memberTool(hooks)
      expect(reads).toBe(1)

      // Ten seconds on it is asked again, not a minute: the failure was never kept as the answer. With nothing
      // kept, the step waits for that read, so it is the definition, not the summary, the step is offered.
      setSystemTime(new Date("2026-10-27T09:00:11Z"))
      const next = memberTool(hooks)
      await until(() => reads === 2)
      answer.resolve({
        description: "Search enrolled students",
        parameters: { type: "object", properties: { query: {} } },
      })
      expect((await next).description).toBe("Search enrolled students")
      expect(reads).toBe(2)
    } finally {
      setSystemTime()
    }
  })

  test("withholds a previous staff definition when its current authorization read fails", async () => {
    let reads = 0
    const { hooks } = await plugin(BOUND, {
      memberDefinition: async () => {
        reads += 1
        if (reads > 1) throw new Error("offline")
        return { description: "Search enrolled students", parameters: { type: "object", properties: { query: {} } } }
      },
    })
    expect((await memberTool(hooks, "ses_members", "turn_1")).description).toBe("Search enrolled students")
    expect((await memberTool(hooks, "ses_members", "turn_2")).parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
    await memberTool(hooks, "ses_members", "turn_2")
    expect(reads).toBe(2)
  })

  test("reads the member definition anew on account switches even within the same turn", async () => {
    let account = "teacher"
    const asked: string[] = []
    const { hooks } = await plugin(BOUND, {
      account: async () => ({ ok: true, id: account }),
      memberDefinition: async () => {
        asked.push(account)
        return account === "teacher"
          ? { description: "Search enrolled students", parameters: { type: "object", properties: { query: {} } } }
          : { description: "Read instructors", parameters: { type: "object", properties: {} } }
      },
    })
    expect((await memberTool(hooks, "ses_members", "turn_1")).description).toBe("Search enrolled students")

    // Signed in as a student within the minute: the teacher's definition is not theirs to see.
    account = "student"
    expect((await memberTool(hooks, "ses_members", "turn_1")).description).toBe("Read instructors")
    account = "teacher"
    expect((await memberTool(hooks, "ses_members", "turn_1")).description).toBe("Search enrolled students")
    expect(asked).toEqual(["teacher", "student", "teacher"])
  })

  // Kept under "signed out" instead, every session would share one key while the read failed.
  test("discards a definition if the account changes while it is being read", async () => {
    let account = "teacher"
    const { hooks } = await plugin(BOUND, {
      account: async () => ({ ok: true, id: account }),
      memberDefinition: async () => {
        account = "student"
        return { description: "Search enrolled students", parameters: { type: "object", properties: { query: {} } } }
      },
    })
    expect((await memberTool(hooks, "ses_members", "turn_1")).parameters).not.toHaveProperty("properties.query")
  })

  test("offers the summary and reads nothing while the signed-in account cannot be read", async () => {
    let asked = 0
    const { hooks } = await plugin(BOUND, {
      account: async () => ({ ok: false }),
      memberDefinition: async () => {
        asked += 1
        return { description: "Search enrolled students", parameters: { type: "object", properties: {} } }
      },
    })
    expect((await memberTool(hooks)).parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    })
    expect(asked).toBe(0)
  })

  test("shares an in-flight authorization read without keeping it for a later model step", async () => {
    const answer = Promise.withResolvers<MemberDefinition>()
    let reads = 0
    const { hooks } = await plugin(BOUND, {
      memberDefinition: () => {
        reads += 1
        return answer.promise
      },
    })
    const first = memberTool(hooks)
    const overlapping = memberTool(hooks)
    await until(() => reads === 1)
    answer.resolve({ description: "Read instructors", parameters: { type: "object", properties: {} } })
    expect((await first).description).toBe("Read instructors")
    expect((await overlapping).description).toBe("Read instructors")
    expect(reads).toBe(1)
    await memberTool(hooks)
    expect(reads).toBe(2)
  })

  test("hides the binding fields of the server's member definition from the model", async () => {
    const { hooks } = await plugin(BOUND, {
      memberDefinition: async () => ({
        description: "Search enrolled students",
        parameters: {
          type: "object",
          properties: { courseId: {}, assistantId: {}, sessionId: {}, describeOnly: {}, query: {} },
          required: ["courseId", "query"],
        },
      }),
    })
    expect((await memberTool(hooks)).parameters).toEqual({
      type: "object",
      properties: { query: {} },
      required: ["query"],
    })
  })

  test("shares one definition across model steps and refreshes the role at the next user turn", async () => {
    let staff = true
    let reads = 0
    const { hooks } = await plugin(BOUND, {
      account: async () => ({ ok: true, id: "same-account" }),
      memberDefinition: async () => {
        reads += 1
        return {
          description: staff ? "Search enrolled students" : "Read instructors",
          parameters: { type: "object", properties: staff ? { query: {} } : {} },
        }
      },
    })
    const first = await memberTool(hooks, "ses_members", "turn_1")
    expect(first.parameters).toHaveProperty("properties.query")
    staff = false
    for (let step = 1; step < 10; step++) {
      expect(await memberTool(hooks, "ses_members", "turn_1")).toEqual(first)
    }
    expect(reads).toBe(1)
    expect((await memberTool(hooks, "ses_members", "turn_2")).parameters).not.toHaveProperty("properties.query")
    expect(reads).toBe(2)
  })

  test("pins a failed turn's fallback even after cooldown and retries only for a later turn", async () => {
    let reads = 0
    const { hooks } = await plugin(BOUND, {
      memberDefinition: async () => {
        reads += 1
        if (reads === 1) throw new Error("offline")
        return { description: "Search enrolled students", parameters: { type: "object", properties: { query: {} } } }
      },
    })
    try {
      setSystemTime(new Date("2026-10-27T09:00:00Z"))
      const first = await memberTool(hooks, "ses_members", "turn_1")
      expect(first.parameters).not.toHaveProperty("properties.query")
      setSystemTime(new Date("2026-10-27T09:00:11Z"))
      expect(await memberTool(hooks, "ses_members", "turn_1")).toEqual(first)
      expect(reads).toBe(1)
      expect((await memberTool(hooks, "ses_members", "turn_2")).parameters).toHaveProperty("properties.query")
      expect(reads).toBe(2)
    } finally {
      setSystemTime()
    }
  })

  test("injects the member query's binding and session instead of model-supplied ids", async () => {
    const { hooks } = await plugin(BOUND)
    // A model that asks for the definition instead of the members would only waste the call.
    const output = {
      args: { courseId: 999, assistantId: 999, sessionId: "foreign", describeOnly: true, query: "Smith" } as Record<
        string,
        unknown
      >,
    }
    await hooks["tool.execute.before"](
      {
        tool: "jolliedu_get_course_members",
        sessionID: "ses_members",
        callID: "call_members",
        parameters: { type: "object", properties: { courseId: {}, assistantId: {}, sessionId: {}, query: {} } },
      },
      output,
    )
    expect(output.args).toEqual({ courseId: 7, assistantId: 12, sessionId: "ses_members", query: "Smith" })
  })

  /**
   * ⚠ A TURN REFUSED AS CLOSED IS REMEMBERED LIKE A REFUSED START. An assistant that waits to be
   * spoken to is offered by the same clock, so the catalogue this process serves next has to close it.
   */
  test("remembers an assistant whose turn the gateway refused as closed, and nothing else", async () => {
    const catalog = { status: "ok" as const, courses: [], assistants: [], modelTiers: {} }
    const refused = (code: string, sessionID?: string) =>
      ({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            error: {
              name: "APIError",
              data: { message: "", isRetryable: false, responseBody: JSON.stringify({ code }) },
            },
          },
        },
      }) as never
    JolliClosedAssistants.reset()

    await (await plugin()).hooks.event?.(refused("assistant_closed", "ses_1"))
    await (await plugin(BOUND)).hooks.event?.(refused("course_archived", "ses_1"))
    await (await plugin(BOUND)).hooks.event?.(refused("assistant_closed"))
    // Unbound, another code, no session: nothing to remember, so the catalogue is served as it came.
    expect(JolliClosedAssistants.apply(catalog)).toBe(catalog)

    await (await plugin(BOUND)).hooks.event?.(refused("assistant_closed", "ses_1"))
    expect(JolliClosedAssistants.apply(catalog)).not.toBe(catalog)
    JolliClosedAssistants.reset()
  })

  test("hides the server-owned binding from model-facing course tool schemas", async () => {
    const { hooks } = await plugin()
    const output: { description: string; parameters: Record<string, unknown> } = {
      description: "course context",
      parameters: {
        type: "object",
        properties: {
          courseId: { type: "number" },
          assistantId: { type: "number" },
          question: { type: "string" },
        },
        required: ["courseId", "assistantId", "question"],
        additionalProperties: false,
      },
    }

    await hooks["tool.definition"]?.({ toolID: "jolliedu_search_remote_course_materials" }, output)

    expect(output.parameters).toEqual({
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    })
  })

  test("preserves list schemas and server descriptions while adding complete-list guidance", async () => {
    const { hooks } = await plugin()
    const pageNumber = {
      type: "integer",
      description: "To read the next page, pass the nextPage the previous one returned.",
    }
    const opaqueCursor = {
      type: "string",
      description: "To read the next page, pass the nextCursor the previous one returned.",
    }
    const binding = { courseId: { type: "number" }, assistantId: { type: "number" }, sessionId: { type: "string" } }
    const lists = [
      ["jolliedu_list_remote_course_assignments", { ...binding, page: pageNumber }, { page: pageNumber }],
      ["jolliedu_list_all_materials_in_remote_course", { ...binding, cursor: opaqueCursor }, { cursor: opaqueCursor }],
      ["jolliedu_list_user_attachments", { cursor: opaqueCursor }, { cursor: opaqueCursor }],
    ] as const
    for (const [toolID, declared, shown] of lists) {
      const description = "List them. When `hasMore` is true, tell the student in their language."
      const output: { description: string; parameters: { type: string; properties: Record<string, unknown> } } = {
        description,
        parameters: { type: "object", properties: declared },
      }

      await hooks["tool.definition"]?.({ toolID }, output)

      expect(output.description).toStartWith(description)
      expect(output.description).toContain("follow every page until hasMore is false")
      expect(output.parameters.properties).toEqual(shown)
    }
    // A system sentence that follows the paging state would invalidate the cached prompt prefix.
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined()
    expect(hooks["experimental.text.complete"]).toBeUndefined()
  })

  test("injects and overwrites the binding in the original MCP argument object", async () => {
    const { hooks } = await plugin(BOUND)
    const args: Record<string, unknown> = { question: "What is this lesson about?", courseId: 999 }

    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_search_remote_course_materials", sessionID: "ses_test", callID: "call_test" },
      { args },
    )

    expect(args).toEqual({ question: "What is this lesson about?", courseId: 7, assistantId: 12 })
  })

  test("sends the session's own id to a course tool whose server-side schema takes it, and to no other", async () => {
    const { hooks } = await plugin(BOUND)
    const takesSession = {
      description: "Read",
      parameters: { type: "object", properties: { courseId: {}, assistantId: {}, sessionId: {}, number: {} } },
    }
    const older = { description: "Read", parameters: { type: "object", properties: { courseId: {}, id: {} } } }
    const workSchema = structuredClone(takesSession.parameters)
    await hooks["tool.definition"]?.({ toolID: "jolliedu_read_student_work" }, takesSession)
    await hooks["tool.definition"]?.({ toolID: "jolliedu_get_remote_material_content" }, older)
    const work: Record<string, unknown> = { number: 1, sessionId: "ses_forged" }
    const material: Record<string, unknown> = { id: 3, sessionId: "ses_forged" }

    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_read_student_work", sessionID: "ses_test", callID: "call_1", parameters: workSchema },
      { args: work },
    )
    await hooks["tool.execute.before"]?.(
      {
        tool: "jolliedu_get_remote_material_content",
        sessionID: "ses_test",
        callID: "call_2",
        parameters: older.parameters,
      },
      { args: material },
    )

    expect(work).toEqual({ number: 1, sessionId: "ses_test", courseId: 7, assistantId: 12 })
    // A server from before the tool took the session refuses an argument its schema does not declare, and the
    // model never names one: the id it forged is dropped too.
    expect(material).toEqual({ id: 3, courseId: 7, assistantId: 12 })
  })

  test("concurrent calls use their captured schemas despite another session or relist", async () => {
    const { hooks } = await plugin(BOUND)
    const tool = "jolliedu_read_student_work"
    const current = { type: "object", properties: { sessionId: {} }, additionalProperties: false }
    const older = { type: "object", properties: {}, additionalProperties: false }
    for (const lastSeen of [current, older]) {
      await hooks["tool.definition"]?.({ toolID: tool }, { description: "Read", parameters: structuredClone(lastSeen) })
      const calls = [
        { sessionID: "ses_new", parameters: current, args: { sessionId: "ses_forged" } as Record<string, unknown> },
        { sessionID: "ses_old", parameters: older, args: { sessionId: "ses_forged" } as Record<string, unknown> },
      ]
      await Promise.all(
        calls.map((call, index) =>
          hooks["tool.execute.before"]?.(
            { tool, sessionID: call.sessionID, callID: `call_${index}`, parameters: call.parameters },
            { args: call.args },
          ),
        ),
      )
      expect(calls[0].args.sessionId).toBe("ses_new")
      expect(calls[1].args).not.toHaveProperty("sessionId")
    }
  })

  test("refuses a course tool when the session has no valid binding", async () => {
    const { hooks } = await plugin({ jolli: { courseId: "0", assistantId: "12" } })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_get_conversation_context", sessionID: "ses_test", callID: "call_test" },
        { args: { courseId: 7, assistantId: 12 } },
      ),
    ).rejects.toThrow("valid session course and assistant binding")
  })

  test("reads the session only for course tools", async () => {
    const { hooks, reads } = await plugin(BOUND)

    await hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "ses_test", callID: "call_1" }, { args: {} })
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_2" },
      { args: {} },
    )
    expect(reads()).toBe(0)

    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_search_remote_course_materials", sessionID: "ses_test", callID: "call_3" },
      { args: { question: "q" } },
    )
    expect(reads()).toBe(1)
  })

  test("does not add binding fields to unrelated Jolliedu tools", async () => {
    const { hooks } = await plugin(BOUND)
    const args = {}

    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_test" },
      { args },
    )

    expect(args).toEqual({})
  })

  /** Only a course tool's arguments are the client's to refuse; any other tool's go to MCP to validate. */
  test("refuses non-object arguments to course tools only", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.before"](
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_1" },
      { args: "next" },
    )
    await expect(
      hooks["tool.execute.before"](
        { tool: "jolliedu_list_all_materials_in_remote_course", sessionID: "ses_test", callID: "call_2" },
        { args: "next" },
      ),
    ).rejects.toThrow("Course tool arguments must be an object.")
  })

  test("records the evidence a course read returned on its tool part, from the whole result", async () => {
    const { hooks } = await plugin(BOUND)
    const output = page({
      id: 3,
      title: "Lecture 4: Pointers",
      lines: [{ number: 1, text: "A pointer holds an address." }],
    }) as {
      metadata?: Record<string, unknown>
    }
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID: "call_1", args: {} },
      output as never,
    )
    expect(output.metadata).toEqual({
      evidence: [
        { kind: "material", materialId: "3", title: "Lecture 4: Pointers", text: "A pointer holds an address." },
      ],
    })
  })

  test("records and logs work source identities without requiring a URL or logging the work text", async () => {
    const logs: unknown[] = []
    const bridge = await Effect.runPromise(
      EffectBridge.make().pipe(Effect.provide(Logger.layer([Logger.make((options) => logs.push(options.message))]))),
    )
    const hooks = await JolliCourseChatPlugin({} as PluginInput, {
      bridge,
      citationsShown: async () => true,
      account: async () => ({ ok: true }),
    })
    const source = {
      kind: "student_work",
      courseId: 11,
      assignmentId: 5,
      taskId: 30,
      category: "feedback",
      sourceId: "feedback:30",
      title: "Teacher feedback",
    }
    const output = { ...page({ citationEvidence: [{ source, text: "Private teacher comments" }] }), metadata: {} }
    await hooks["tool.execute.after"]?.(
      { tool: JolliSources.WORK_TOOLS[1], sessionID: "ses_test", callID: "call_work", args: {} },
      output,
    )
    expect(output.metadata).toEqual({ evidence: [{ ...source, text: "Private teacher comments" }] })
    expect(logs).toEqual([
      [
        "jolli course tool",
        { "session.id": "ses_test", tool: JolliSources.WORK_TOOLS[1], failed: false, evidence: [source] },
      ],
    ])
  })

  test("records keyword passages on the tool part for citation selection", async () => {
    const { hooks } = await plugin(BOUND)
    const output = page({
      id: 3,
      title: "Lecture 4: Pointers",
      keywords: ["heap"],
      passages: [
        { lines: [{ number: 42, text: "Allocate on the heap." }] },
        { lines: [{ number: 80, text: "Free the allocation once." }] },
      ],
    }) as { metadata?: Record<string, unknown> }
    await hooks["tool.execute.after"]?.(
      {
        tool: "jolliedu_get_remote_material_content",
        sessionID: "ses_test",
        callID: "call_1",
        args: { id: 3, keywords: ["heap"] },
      },
      output as never,
    )
    expect(output.metadata).toEqual({
      evidence: [
        { kind: "material", materialId: "3", title: "Lecture 4: Pointers", text: "Allocate on the heap." },
        { kind: "material", materialId: "3", title: "Lecture 4: Pointers", text: "Free the allocation once." },
      ],
    })
  })

  test("leaves a result that returned no material text alone", async () => {
    const { hooks } = await plugin(BOUND)
    const output = page({ results: [{ id: 3, title: "Lecture 4", evidenceKind: "search_preview" }] }) as {
      metadata?: Record<string, unknown>
    }
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_search_remote_course_materials", sessionID: "ses_test", callID: "call_1", args: {} },
      output as never,
    )
    expect(output.metadata).toBeUndefined()
  })

  test("records no evidence where the course hides citations, and records it where that cannot be read", async () => {
    const read = () =>
      page({ id: 3, title: "Lecture 4", lines: [{ number: 1, text: "A pointer holds an address." }] }) as {
        metadata?: Record<string, unknown>
      }
    for (const [shown, recorded] of [
      [false, false],
      [undefined, true],
    ] as const) {
      const { hooks } = await plugin(BOUND, { citationsShown: async () => shown })
      const output = read()
      await hooks["tool.execute.after"]?.(
        { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID: "call_1", args: {} },
        output as never,
      )
      expect(output.metadata !== undefined).toBe(recorded)
    }
  })

  test("asks whether the course shows citations once for a session's reads, not once per read", async () => {
    let asked = 0
    const { hooks } = await plugin(BOUND, {
      citationsShown: async () => {
        asked += 1
        return true
      },
    })
    const read = (callID: string) =>
      hooks["tool.execute.after"]?.(
        { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID, args: {} },
        page({ id: 3, title: "Lecture 4", lines: [{ number: 1, text: "A pointer holds an address." }] }),
      )
    // Two reads of one parallel step, then a read of the next step.
    await Promise.all([read("call_1"), read("call_2")])
    await read("call_3")
    expect(asked).toBe(1)
  })

  test("awaits the refreshed citations switch before recording evidence past its minute", async () => {
    const answers = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()]
    let asked = 0
    const { hooks } = await plugin(BOUND, {
      citationsShown: () => {
        asked += 1
        return (answers[asked - 1] ?? answers[0]!).promise
      },
    })
    const before = (callID: string) =>
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID },
        { args: {} },
      )
    const after = async (callID: string) => {
      const output = page({
        id: 3,
        title: "Lecture 4",
        lines: [{ number: 1, text: "A pointer holds an address." }],
      }) as {
        metadata?: Record<string, unknown>
      }
      await hooks["tool.execute.after"]?.(
        { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID, args: {} },
        output as never,
      )
      return output
    }
    try {
      setSystemTime(new Date("2026-10-27T09:00:00Z"))
      await before("call_1")
      answers[0]?.resolve(true)
      expect((await after("call_1")).metadata).toHaveProperty("evidence")

      setSystemTime(new Date("2026-10-27T09:01:01Z"))
      await before("call_2")
      expect(asked).toBe(2)
      const refreshed = after("call_2")
      answers[1]?.resolve(false)
      expect((await refreshed).metadata).toBeUndefined()
      expect((await after("call_3")).metadata).toBeUndefined()
    } finally {
      setSystemTime()
    }
  })

  test("asks whether the course shows citations as a course read goes out, not once its result is back", async () => {
    const answer = Promise.withResolvers<boolean>()
    const asked: string[] = []
    const { hooks } = await plugin(BOUND, {
      citationsShown: (sessionID) => {
        asked.push(sessionID)
        return answer.promise
      },
    })
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID: "call_1" },
      { args: {} },
    )
    expect(asked).toEqual(["ses_test"])

    // The answer arrives while the call is still running; the result then waits on nothing.
    answer.resolve(true)
    const output = page({ id: 3, title: "Lecture 4", lines: [{ number: 1, text: "A pointer holds an address." }] }) as {
      metadata?: Record<string, unknown>
    }
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_get_remote_material_content", sessionID: "ses_test", callID: "call_1", args: {} },
      output as never,
    )
    expect(asked).toEqual(["ses_test"])
    expect(output.metadata).toHaveProperty("evidence")
  })

  test("accepts only returned cursors for both legacy and current list schemas", async () => {
    const { hooks } = await plugin(BOUND)
    const calls = [
      ["jolliedu_list_remote_course_assignments", "page", 1],
      ["jolliedu_list_all_materials_in_remote_course", "afterId", 42],
      ["jolliedu_list_all_materials_in_remote_course", "cursor", "opaque-material-token"],
      ["jolliedu_list_user_attachments", "cursor", "opaque-upload-token"],
    ] as const
    for (const [tool, cursor, next] of calls) {
      const input = { tool, sessionID: "ses_test", callID: "call_1", parameters: { properties: { [cursor]: {} } } }
      const args: Record<string, unknown> = {}
      await hooks["tool.execute.before"]?.(input, { args })
      await hooks["tool.execute.after"]?.(
        { tool, sessionID: "ses_test", callID: "call_1", args },
        page({ hasMore: true, [cursor === "page" ? "nextPage" : "nextCursor"]: next }),
      )
      const continuation: Record<string, unknown> = { [cursor]: next }
      await hooks["tool.execute.before"]?.(input, { args: continuation })
      expect(continuation).toEqual({ ...args, [cursor]: next })
      await expectCursorRejected(hooks["tool.execute.before"](input, { args: { [cursor]: "invented" } }))
      const fresh: Record<string, unknown> = {}
      await hooks["tool.execute.before"]?.(input, { args: fresh })
      expect(fresh).toEqual(tool === "jolliedu_list_user_attachments" ? {} : { courseId: 7, assistantId: 12 })
    }
  })

  /** Every way the servers' schemas let a first page be asked for: no page before it returned a cursor. */
  test.each([
    ["jolliedu_list_remote_course_assignments", "page", {}],
    ["jolliedu_list_remote_course_assignments", "page", { page: 0 }],
    ["jolliedu_list_remote_course_assignments", "page", { page: null }],
    ["jolliedu_list_all_materials_in_remote_course", "cursor", { cursor: null }],
    ["jolliedu_list_all_materials_in_remote_course", "afterId", { afterId: null }],
    ["jolliedu_list_user_attachments", "cursor", { cursor: null }],
  ] as const)("asks %s for its first page with %s as %j", async (tool, cursor, given) => {
    const { hooks } = await plugin(BOUND)
    const args: Record<string, unknown> = { ...given }
    await hooks["tool.execute.before"](
      { tool, sessionID: "ses_test", callID: "call_page", parameters: { properties: { [cursor]: {} } } },
      { args },
    )
    // A null cursor is left out rather than sent, as an unset one.
    expect(args[cursor]).toBe(given[cursor as keyof typeof given] ?? undefined)
  })

  test("rejects invented page numbers and does not reuse cursors across sessions or filters", async () => {
    const { hooks } = await plugin(BOUND)
    const tool = "jolliedu_list_remote_course_assignments"
    const input = { tool, sessionID: "ses_test", callID: "call_page" }
    // Pages start at 0, as the server numbers them: page 1 is the second page, and needs a page that returned it.
    await expectCursorRejected(hooks["tool.execute.before"](input, { args: { page: 1 } }))
    const args = { page: 0, assignmentId: 5 }
    await hooks["tool.execute.before"]?.(input, { args })
    await hooks["tool.execute.after"]?.({ ...input, args }, page({ hasMore: true, nextPage: 1 }))
    await expectCursorRejected(hooks["tool.execute.before"](input, { args: { page: 1, assignmentId: 6 } }))
    await expectCursorRejected(
      hooks["tool.execute.before"]({ ...input, sessionID: "ses_other" }, { args: { page: 1, assignmentId: 5 } }),
    )
    await hooks["tool.execute.before"]?.(input, { args: { assignmentId: 5, page: 1 } })
  })

  test("lets opaque material cursors carry their catalog and level, while legacy cursors keep their filters", async () => {
    const { hooks } = await plugin(BOUND)
    const input = {
      tool: "jolliedu_list_all_materials_in_remote_course",
      sessionID: "ses_test",
      callID: "call_page",
      parameters: { properties: { cursor: {} } },
    }
    const first = { catalog: "agent_only", underMaterialId: 42 }
    await hooks["tool.execute.before"]?.(input, { args: first })
    await hooks["tool.execute.after"]?.({ ...input, args: first }, page({ hasMore: true, nextCursor: "opaque-one" }))
    const second = { cursor: "opaque-one" }
    await hooks["tool.execute.before"]?.(input, { args: second })
    await hooks["tool.execute.after"]?.({ ...input, args: second }, page({ hasMore: true, nextCursor: "opaque-two" }))
    await hooks["tool.execute.before"]?.(input, { args: { ...first, cursor: "opaque-two" } })

    const legacy = { ...input, parameters: { properties: { afterId: {} } } }
    await hooks["tool.execute.after"]?.({ ...legacy, args: first }, page({ hasMore: true, nextCursor: 12 }))
    await expectCursorRejected(hooks["tool.execute.before"](legacy, { args: { afterId: 12 } }))
    await hooks["tool.execute.before"]?.(legacy, { args: { ...first, afterId: 12 } })
  })

  /** The model may write an unset filter as null on one page and leave it out on the next. */
  test("keys a list alike whether an unset filter is null or left out", async () => {
    const { hooks } = await plugin(BOUND)
    const input = {
      tool: "jolliedu_list_all_materials_in_remote_course",
      sessionID: "ses_test",
      callID: "call_page",
      parameters: { properties: { afterId: {} } },
    }
    const first = { catalog: "agent", underMaterialId: null }
    await hooks["tool.execute.before"](input, { args: first })
    await hooks["tool.execute.after"]({ ...input, args: first }, page({ hasMore: true, nextCursor: 12 }))
    const second = { catalog: "agent", afterId: 12 }
    await hooks["tool.execute.before"](input, { args: second })
    await hooks["tool.execute.after"]({ ...input, args: second }, page({ hasMore: true, nextCursor: 24 }))
    await hooks["tool.execute.before"](input, { args: { catalog: "agent", underMaterialId: null, afterId: 24 } })
    await expectCursorRejected(hooks["tool.execute.before"](input, { args: { catalog: "course", afterId: 24 } }))
  })

  /** The bound drops the list least recently paged through, not the one started first. */
  test("keeps a list being paged through when other lists fill the bound", async () => {
    const { hooks } = await plugin(BOUND)
    const tool = "jolliedu_list_remote_course_assignments"
    const listed = async (sessionID: string) => {
      const args = {}
      await hooks["tool.execute.before"]({ tool, sessionID, callID: "call_page" }, { args })
      await hooks["tool.execute.after"](
        { tool, sessionID, callID: "call_page", args },
        page({ hasMore: true, nextPage: 1 }),
      )
    }
    const next = (sessionID: string) =>
      hooks["tool.execute.before"]({ tool, sessionID, callID: "call_page" }, { args: { page: 1 } })

    await listed("ses_paging")
    // With the 255 below, the plugin's 256 lists are full; the next list drops the least recently used.
    for (const index of Array.from({ length: 255 }, (_, index) => index)) await listed(`ses_${index}`)
    await next("ses_paging")
    await listed("ses_last")

    await next("ses_paging")
    await expectCursorRejected(next("ses_0"))
  })

  test("does not accept cursors from failed or malformed list results", async () => {
    const { hooks } = await plugin(BOUND)
    const input = { tool: "jolliedu_list_remote_course_assignments", sessionID: "ses_test", callID: "call_page" }
    const args = {}
    await hooks["tool.execute.before"]?.(input, { args })
    for (const output of [
      { ...page({ hasMore: true, nextPage: 2 }), isError: true },
      page({ hasMore: true, nextPage: "2" }),
      page({ hasMore: false, nextPage: 2 }),
    ]) {
      await hooks["tool.execute.after"]?.({ ...input, args }, output)
      await expectCursorRejected(hooks["tool.execute.before"](input, { args: { page: 2 } }))
    }
  })

  test("leaves schema keys a course tool never had absent", async () => {
    const { hooks } = await plugin(BOUND)
    const output: { description: string; parameters: Record<string, unknown> } = {
      description: "course context",
      parameters: { type: "object" },
    }

    await hooks["tool.definition"]?.({ toolID: "jolliedu_get_conversation_context" }, output)

    expect(Object.keys(output.parameters)).toEqual(["type"])
  })

  test("reports a session it could not read as a read failure, not as a missing binding", async () => {
    const hooks = await JolliCourseChatPlugin({} as PluginInput, { bridge: failingSessionBridge() })

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_get_conversation_context", sessionID: "ses_test", callID: "call_1" },
        { args: {} },
      ),
    ).rejects.toThrow("Could not read this session's course binding")
  })
})

/**
 * The hook tests above hand the plugin a bridge they built themselves, which says nothing about the
 * bridge production builds: `Plugin.node` captures it from its own layer, so a service missing from
 * that node's dependencies only shows up here.
 */
/** What the course server's member tool was asked, and in which org, in the plugin layer tests. */
const memberReads: { arguments: unknown; org: unknown }[] = []
/** Set to have the course server answer as jolliedu answers a handler that threw: an `isError` result. */
let memberServerFails = false
let memberClient: Client | undefined

/**
 * A course server offering the member tool, reached through a real MCP client connected to it in memory. Only
 * the MCP service is replaced, so that it lists this server's tools as the Jolli connection's.
 */
const courseServer = Layer.unwrap(
  Effect.promise(async () => {
    const server = new Server({ name: "jolliedu", version: "1.0.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_course_members",
          inputSchema: {
            type: "object",
            properties: {
              courseId: { type: "integer" },
              assistantId: { type: "integer" },
              sessionId: { type: "string" },
              describeOnly: { type: "boolean" },
              query: { type: "string" },
            },
            required: ["courseId", "assistantId"],
          },
        },
      ],
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      memberReads.push({ arguments: request.params.arguments, org: JolliMcpCall.current()?.org })
      if (memberServerFails) return { isError: true, content: [{ type: "text", text: "An internal error occurred." }] }
      const parameters = { type: "object", properties: { courseId: { type: "integer" }, query: { type: "string" } } }
      return {
        content: [{ type: "text", text: JSON.stringify({ description: "Search enrolled students", parameters }) }],
      }
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "jollicode", version: "1.0.0" })
    memberClient = client
    await client.connect(clientTransport)
    const listed = await client.listTools()
    return Layer.mock(MCP.Service, {
      tools: () =>
        Effect.succeed(
          Object.fromEntries(
            listed.tools.map((def) => [`jolliedu_${def.name}`, { def, client, server: "jolliedu", timeout: 12_000 }]),
          ),
        ),
    })
  }),
)

const withPluginLayer = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [MCP.node, courseServer],
  ]),
)

describe("plugin.jolli-course-chat through the plugin layer", () => {
  withPluginLayer.instance("resolves the session binding with only the plugin layer's own services", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const plugin = yield* Plugin.Service
      const session = yield* sessions.create({ metadata: BOUND })
      // Initialized from a caller that has no Session, so the bridge can only reach one through
      // `Plugin.node`'s own dependencies rather than through whichever fiber happened to start it.
      yield* plugin
        .init()
        .pipe(
          Effect.updateContext((context: Context.Context<Session.Service>) => Context.omit(Session.Service)(context)),
        )
      const output = { args: { question: "What is this lesson about?", courseId: 999 } as Record<string, unknown> }

      yield* plugin.trigger(
        "tool.execute.before",
        { tool: "jolliedu_search_remote_course_materials", sessionID: session.id, callID: "call_layer" },
        output,
      )

      expect(output.args).toEqual({ question: "What is this lesson about?", courseId: 7, assistantId: 12 })
    }),
  )

  withPluginLayer.instance("reads the member tool's definition with only the plugin layer's own services", () =>
    Effect.gen(function* () {
      memberReads.length = 0
      const sessions = yield* Session.Service
      const plugin = yield* Plugin.Service
      const session = yield* sessions.create({
        metadata: { jolli: { courseId: "acme:main:32", assistantId: "acme:main:3" } },
      })
      // Initialized from a caller with neither Session nor MCP, so the bridge reaches them only through
      // `Plugin.node`'s own dependencies; a missing one would leave staff the summary-only tool, silently.
      yield* plugin
        .init()
        .pipe(
          Effect.updateContext((context: Context.Context<Session.Service>) =>
            Context.omit(Session.Service, MCP.Service)(context),
          ),
        )
      const call = spyOn(memberClient!, "callTool")
      const output = { description: "Listed", parameters: {} as Record<string, unknown> }

      yield* plugin.trigger("tool.definition", { toolID: JolliSources.MEMBERS_TOOL, sessionID: session.id }, output)

      expect(output).toEqual({
        description: "Search enrolled students",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      })
      expect(call).toHaveBeenCalledWith(expect.anything(), undefined, { timeout: 12_000 })
      call.mockRestore()
      // Asked for the definition alone, in the session's org: one connection serves every session.
      expect(memberReads).toEqual([
        {
          arguments: { courseId: 32, assistantId: 3, sessionId: session.id, describeOnly: true },
          org: { tenantSlug: "acme", orgSlug: "main" },
        },
      ])
    }),
  )

  // Read as "no definition", the error would stand in for a teacher's definition for a whole minute.
  withPluginLayer.instance(
    "offers the summary on an error the course server reports, and asks again after a rest",
    () =>
      Effect.gen(function* () {
        memberReads.length = 0
        const sessions = yield* Session.Service
        const plugin = yield* Plugin.Service
        const session = yield* sessions.create({
          metadata: { jolli: { courseId: "acme:main:32", assistantId: "acme:main:3" } },
        })
        const step = Effect.fn(function* () {
          const output = { description: "Listed", parameters: {} as Record<string, unknown> }
          yield* plugin.trigger("tool.definition", { toolID: JolliSources.MEMBERS_TOOL, sessionID: session.id }, output)
          return output.description
        })

        yield* Effect.sync(() => {
          setSystemTime(new Date("2026-10-27T09:00:00Z"))
          memberServerFails = true
        })
        expect(yield* step()).toBe("Read this course's instructor list and enrolled student count.")

        yield* Effect.sync(() => {
          memberServerFails = false
          setSystemTime(new Date("2026-10-27T09:00:11Z"))
        })
        expect(yield* step()).toBe("Search enrolled students")
        expect(memberReads).toHaveLength(2)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            memberServerFails = false
            setSystemTime()
          }),
        ),
      ),
  )
})
