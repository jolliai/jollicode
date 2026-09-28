import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { Effect, Layer } from "effect"
import type { EffectBridge } from "@/effect/bridge"
import { JolliCourseChatPlugin } from "@/plugin/jolli-course-chat"
import { Session } from "@/session/session"

/**
 * A bridge over a session that only answers reads. Paging state belongs to the plugin, so a write
 * to the session's metadata would be a regression, and it fails the test that makes it.
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
              setMetadata: () => Effect.die(new Error("paging state must not be written into session metadata")),
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
  return { content: [{ type: "text", text: JSON.stringify(body) }] } as never
}

async function plugin(metadata?: Record<string, unknown>) {
  const session = sessionBridge(metadata)
  const hooks = await JolliCourseChatPlugin({} as PluginInput, { bridge: session.bridge })
  return { hooks, reads: session.reads }
}

describe("plugin.jolli-course-chat", () => {
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

  test("shows a continuation flag while hiding list cursors from the model", async () => {
    const { hooks } = await plugin()
    const output = {
      description: "list attachments",
      parameters: {
        type: "object",
        properties: { limit: { type: "number" }, cursor: { type: "string" } },
        required: [] as string[],
      },
    }

    await hooks["tool.definition"]?.({ toolID: "jolliedu_list_user_attachments" }, output)

    expect(output.parameters.properties).toHaveProperty("continue")
    expect(output.parameters.properties).not.toHaveProperty("cursor")
    expect(output.description).toContain("continue=true")
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
    await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_test", model: {} as never }, { system: [] })
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

  test("stores an attachment cursor and injects it only for a continuation", async () => {
    const { hooks } = await plugin(BOUND)
    const cursor = "opaque-page-token"
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: cursor, hasMore: true }),
    )

    const more: Record<string, unknown> = { continue: true, cursor: "invented" }
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_2" },
      { args: more },
    )
    expect(more).toEqual({ cursor })

    const fresh: Record<string, unknown> = { cursor: "invented" }
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_3" },
      { args: fresh },
    )
    expect(fresh).toEqual({})
  })

  test("keeps course and attachment cursors separate and binds course continuation", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      {
        tool: "jolliedu_list_all_materials_in_remote_course",
        sessionID: "ses_test",
        callID: "call_1",
        args: { courseId: 7, assistantId: 12 },
      },
      page({ results: [{ id: 9 }], nextCursor: 9, hasMore: true }),
    )
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_2", args: {} },
      page({ results: [{ id: 3 }], nextCursor: "attachment-page", hasMore: true }),
    )

    const materials: Record<string, unknown> = { continue: true, afterId: 999, courseId: 999 }
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_all_materials_in_remote_course", sessionID: "ses_test", callID: "call_3" },
      { args: materials },
    )
    expect(materials).toEqual({ courseId: 7, assistantId: 12, afterId: 9 })

    const attachments: Record<string, unknown> = { continue: true }
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_4" },
      { args: attachments },
    )
    expect(attachments).toEqual({ cursor: "attachment-page" })
  })

  test("does not restart an exhausted list when the model asks for a continuation", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: null, hasMore: false }),
    )

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_2" },
        { args: { continue: true } },
      ),
    ).rejects.toThrow("No more attachments")
  })

  test("treats a page that says hasMore=false as the last one, whatever cursor it carries", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: "leftover", hasMore: false }),
    )

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_2" },
        { args: { continue: true } },
      ),
    ).rejects.toThrow("No more attachments")
  })

  test("a fresh list that fails leaves no earlier cursor behind to continue from", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: "page-2", hasMore: true }),
    )

    // A fresh request that never reports back (a thrown transport error skips the after hook).
    await hooks["tool.execute.before"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_2" },
      { args: {} },
    )

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_3" },
        { args: { continue: true } },
      ),
    ).rejects.toThrow("No attachment page is saved")
  })

  test("drops the saved cursor when a continuation comes back as an error", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      {
        tool: "jolliedu_list_all_materials_in_remote_course",
        sessionID: "ses_test",
        callID: "call_1",
        args: { courseId: 7, assistantId: 12 },
      },
      page({ results: [{ id: 9 }], nextCursor: 9, hasMore: true }),
    )
    await hooks["tool.execute.after"]?.(
      {
        tool: "jolliedu_list_all_materials_in_remote_course",
        sessionID: "ses_test",
        callID: "call_2",
        args: { courseId: 7, assistantId: 12, afterId: 9 },
      },
      { isError: true, content: [{ type: "text", text: "Course or assistant not found" }] } as never,
    )

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_list_all_materials_in_remote_course", sessionID: "ses_test", callID: "call_3" },
        { args: { continue: true } },
      ),
    ).rejects.toThrow("No course material page is saved")
  })

  test("asks the model to explain partial lists without rewriting its final answer", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_test", callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: "page-2", hasMore: true }),
    )
    const output = { system: [] as string[] }

    await hooks["experimental.chat.system.transform"]?.({ sessionID: "ses_test", model: {} as never }, output)

    expect(output.system.join(" ")).toContain("language of their question")
    expect(output.system.join(" ")).toContain("continue=true")
    expect(hooks["experimental.text.complete"]).toBeUndefined()
  })

  test("keeps each session's cursors to itself", async () => {
    const { hooks } = await plugin(BOUND)
    await hooks["tool.execute.after"]?.(
      { tool: "jolliedu_list_user_attachments", sessionID: "ses_a", callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: "page-2", hasMore: true }),
    )

    await expect(
      hooks["tool.execute.before"]?.(
        { tool: "jolliedu_list_user_attachments", sessionID: "ses_b", callID: "call_2" },
        { args: { continue: true } },
      ),
    ).rejects.toThrow("No attachment page is saved")
  })
})
