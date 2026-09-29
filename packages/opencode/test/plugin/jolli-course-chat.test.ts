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
import { Session } from "@/session/session"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

/**
 * A bridge over a session that only answers reads. Paging state belongs to the plugin, so a write
 * to the session's metadata would be a regression, and it fails the test that makes it.
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

async function plugin(metadata?: Record<string, unknown>, options: { pageWaitMs?: number } = {}) {
  const session = sessionBridge(metadata)
  const hooks = await JolliCourseChatPlugin({} as PluginInput, { bridge: session.bridge, ...options })
  return { hooks, reads: session.reads }
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

  test("explains partial lists from the tool description, leaving the system prompt and final answer alone", async () => {
    const { hooks } = await plugin(BOUND)
    const output = { description: "list attachments", parameters: { type: "object", properties: {} } }

    await hooks["tool.definition"]?.({ toolID: "jolliedu_list_user_attachments" }, output)

    expect(output.description).toContain("in their language")
    expect(output.description).toContain("continue=true")
    // A system sentence that follows the paging state would invalidate the cached prompt prefix.
    expect(hooks["experimental.chat.system.transform"]).toBeUndefined()
    expect(hooks["experimental.text.complete"]).toBeUndefined()
  })

  test("declares the continuation flag even when a list schema has no properties", async () => {
    const { hooks } = await plugin(BOUND)
    const output: { description: string; parameters: Record<string, unknown> } = {
      description: "list attachments",
      parameters: { type: "object", additionalProperties: false },
    }

    await hooks["tool.definition"]?.({ toolID: "jolliedu_list_user_attachments" }, output)

    expect(output.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { continue: expect.objectContaining({ type: "boolean" }) },
    })
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

  test("keeps cursors for a bounded number of sessions, dropping the least recently paged", async () => {
    const { hooks } = await plugin(BOUND)
    const list = (sessionID: string) =>
      hooks["tool.execute.after"]?.(
        { tool: "jolliedu_list_user_attachments", sessionID, callID: "call_1", args: {} },
        page({ results: [{ id: 1 }], nextCursor: `${sessionID}-2`, hasMore: true }),
      )
    const continuation = (sessionID: string) => {
      const args: Record<string, unknown> = { continue: true }
      return hooks["tool.execute.before"]?.(
        { tool: "jolliedu_list_user_attachments", sessionID, callID: "call_2" },
        { args },
      ).then(() => args)
    }
    await list("ses_oldest")
    await list("ses_kept")
    // Paging again makes a session the most recent, so it outlives the ones listed after it.
    await list("ses_oldest")
    for (const index of Array.from({ length: 255 }, (_, index) => index)) await list(`ses_${index}`)

    await expect(continuation("ses_kept")).rejects.toThrow("No attachment page is saved")
    await expect(continuation("ses_oldest")).resolves.toEqual({ cursor: "ses_oldest-2" })
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

  test("holds a second continuation of the same list until the first reports its cursor", async () => {
    const { hooks } = await plugin(BOUND)
    const list = { tool: "jolliedu_list_user_attachments", sessionID: "ses_test" }
    await hooks["tool.execute.after"]?.(
      { ...list, callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: "page-2", hasMore: true }),
    )

    const first: Record<string, unknown> = { continue: true }
    await hooks["tool.execute.before"]?.({ ...list, callID: "call_2" }, { args: first })
    const second: Record<string, unknown> = { continue: true }
    const waiting = hooks["tool.execute.before"]?.({ ...list, callID: "call_3" }, { args: second })
    await hooks["tool.execute.after"]?.(
      { ...list, callID: "call_2", args: first },
      page({ results: [{ id: 2 }], nextCursor: "page-3", hasMore: true }),
    )
    await waiting

    // Read after the first wrote, so the two fetch consecutive pages rather than the same one twice.
    expect(first).toEqual({ cursor: "page-2" })
    expect(second).toEqual({ cursor: "page-3" })
  })

  test("stops waiting for an earlier continuation that never reports back", async () => {
    // The after hook runs only on success, so a continuation that failed would otherwise hold
    // every later one of its list forever.
    const { hooks } = await plugin(BOUND, { pageWaitMs: 20 })
    const list = { tool: "jolliedu_list_user_attachments", sessionID: "ses_test" }
    await hooks["tool.execute.after"]?.(
      { ...list, callID: "call_1", args: {} },
      page({ results: [{ id: 1 }], nextCursor: "page-2", hasMore: true }),
    )
    await hooks["tool.execute.before"]?.({ ...list, callID: "call_2" }, { args: { continue: true } })

    const later: Record<string, unknown> = { continue: true }
    await hooks["tool.execute.before"]?.({ ...list, callID: "call_3" }, { args: later })

    expect(later).toEqual({ cursor: "page-2" })
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
