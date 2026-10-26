import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Npm } from "@opencode-ai/core/npm"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Context, Effect, Layer } from "effect"
import { Account } from "@/account/account"
import { Auth } from "@/auth"
import type { EffectBridge } from "@/effect/bridge"
import { Plugin } from "@/plugin"
import { JolliCourseChatPlugin } from "@/plugin/jolli-course-chat"
import { JolliClosedAssistants } from "@opencode-ai/core/jolli/closed-assistants"
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
  options: { citationsShown?: (sessionID: string) => Promise<boolean | undefined> } = {},
) {
  const session = sessionBridge(metadata)
  const hooks = await JolliCourseChatPlugin({} as PluginInput, {
    bridge: session.bridge,
    citationsShown: async () => true,
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
const withPluginLayer = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, Session.node, SessionProjector.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
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
})
