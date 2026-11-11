import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { groupChatFailure, readFrames } from "@opencode-ai/core/jolli/group-chat"
import { groupChatID } from "@opencode-ai/core/jolli/org-scoped-id"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import type { JolliStore } from "@opencode-ai/core/jolli/store"
import { GlobalBus } from "../../src/bus/global"
import {
  configureGroupChats,
  connectGroupChatClient,
  groupChatAccess,
  sendGroupChatMessage,
  watchGroupChat,
} from "../../src/jolli/group-chat"
import { notificationChat } from "../../src/jolli/group-chat-notifications"

const org = { tenantSlug: "school", orgSlug: "course" }
const id = groupChatID(org, "chat-1")
const encoder = new TextEncoder()
const record = (frame: object) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
const contents = () => events.flatMap((event) => (event.properties.content ? [event.properties.content] : []))
let server: ReturnType<typeof Bun.serve> | undefined
let release: (() => void) | undefined
let removeListener: (() => void) | undefined
const events: { type: string; properties: { content?: string; chatID?: string; reset?: boolean } }[] = []
let conversation: ReadableStreamDefaultController<Uint8Array> | undefined
let streamClosed = false
let streams = 0
let baselines = 0
let baselineResponse: () => Response | Promise<Response> = () => Response.json({ running: false })
let postResponse: (request: Request) => Response | Promise<Response> = () => Response.json({ turnId: 1, seq: 1 })

async function until(check: () => boolean) {
  const end = Date.now() + 1500
  while (!check() && Date.now() < end) await Bun.sleep(5)
  expect(check()).toBe(true)
}
function start() {
  conversation = undefined
  streamClosed = false
  streams = 0
  baselines = 0
  events.length = 0
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/api/me/courses") return Response.json({ home: org, courses: [{ id: 7, org }] })
      if (path === "/api/mercure/config") return Response.json({ enabled: false, hubUrl: null })
      if (path === "/api/notifications/stream")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(record({ type: "connected" }))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (path.endsWith("/turn-baseline")) {
        baselines++
        return baselineResponse()
      }
      if (path.endsWith("/stream")) {
        streams++
        return new Response(
          new ReadableStream({
            start(controller) {
              conversation = controller
              controller.enqueue(record({ type: "connected" }))
            },
            cancel() {
              streamClosed = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (path.endsWith("/messages")) return postResponse(request)
      return Response.json({ error: "Unexpected fake route" }, { status: 404 })
    },
  })
  const request = { origin: server.url.origin, token: "fake-token", identity: crypto.randomUUID() }
  const session = JolliSession.Service.of({
    current: () => Effect.succeed(undefined),
    token: () => Effect.succeed(request.token),
    request: () => Effect.succeed(request),
    refused: () => Effect.succeed(request.token),
    signIn: () => Effect.die(new Error("Unexpected sign in")),
    signOut: () => Effect.void,
  })
  configureGroupChats(session)
  const listener = (event: { payload: { type: string; properties: { content?: string; chatID?: string; reset?: boolean } } }) => {
    if (event.payload.type.startsWith("jolli.groupChat.")) events.push(event.payload)
  }
  GlobalBus.on("event", listener)
  removeListener = () => GlobalBus.off("event", listener)
  release = connectGroupChatClient("window-1")
  return request
}
afterEach(() => {
  release?.()
  removeListener?.()
  server?.stop(true)
  server = undefined
  baselineResponse = () => Response.json({ running: false })
  postResponse = () => Response.json({ turnId: 1, seq: 1 })
})

describe("group chat sidecar relay", () => {
  test("returns at admission, takes sender text only from POST, and finishes with one refresh", async () => {
    let finish: (() => void) | undefined
    postResponse = async (request) => {
      expect(await request.json()).toMatchObject({ sentFrom: "jolli_code", mentionedAssistantId: 21 })
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(record({ type: "message_received" }))
            controller.enqueue(record({ type: "content_chunk", content: "reply", seq: 0 }))
            finish = () => {
              controller.enqueue(record({ type: "processing_complete" }))
              controller.close()
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => baselines === 1 && conversation !== undefined)
    events.length = 0
    await Promise.race([
      sendGroupChatMessage(id, { message: "help", clientRequestId: "r1", mentionedAssistantId: 21 }),
      Bun.sleep(500).then(() => {
        throw new Error("Admission waited for completion")
      }),
    ])
    conversation!.enqueue(record({ type: "content_chunk", content: "reply", seq: 0, frameSeq: 1 }))
    await until(() => events.some((event) => event.properties.content === "reply"))
    expect(events.filter((event) => event.properties.content === "reply")).toHaveLength(1)
    finish!()
    await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
    await Bun.sleep(170)
    expect(events.filter((event) => event.type === "jolli.groupChat.changed")).toHaveLength(1)
  })

  test("joins baseline and buffered frames once, in order", async () => {
    let resume: (() => void) | undefined
    baselineResponse = () =>
      new Promise((resolve) => {
        resume = () =>
          resolve(
            Response.json({
              running: true,
              throughFrameSeq: 1,
              frames: [{ type: "content_chunk", content: "first", seq: 0, frameSeq: 1 }],
            }),
          )
      })
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => conversation !== undefined && resume !== undefined)
    conversation!.enqueue(record({ type: "content_chunk", content: "first", seq: 0, frameSeq: 1 }))
    conversation!.enqueue(record({ type: "content_chunk", content: "second", seq: 1, frameSeq: 2 }))
    resume!()
    await until(() => events.filter((event) => event.properties.content).length === 2)
    expect(events.flatMap((event) => (event.properties.content ? [event.properties.content] : []))).toEqual([
      "first",
      "second",
    ])
  })

  test("readers subscribe without calling a baseline or forwarding answer text", async () => {
    start()
    groupChatAccess(id, "reader")
    await watchGroupChat(id, "window-1", true)
    await until(() => conversation !== undefined)
    events.length = 0
    conversation!.enqueue(record({ type: "content_chunk", content: "private in-progress text", seq: 0 }))
    conversation!.enqueue(record({ type: "processing_complete" }))
    await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
    expect(baselines).toBe(0)
    expect(events.some((event) => event.type === "jolli.groupChat.answer")).toBe(false)
  })

  test.each(["participant", "reader"] as const)(
    "refreshes an open %s chat when another person posts a message with a numeric conversation ID",
    async (access) => {
      start()
      groupChatAccess(id, access)
      await watchGroupChat(id, "window-1", true)
      await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
      events.length = 0

      conversation!.enqueue(record({ type: "group_message_added", convoId: 55, authorId: 2, seq: 1 }))

      await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
      expect(events.find((event) => event.type === "jolli.groupChat.changed")?.properties.chatID).toBe(id)
    },
  )

  test("losing the global event connection closes its upstream without an unwatch", async () => {
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => conversation !== undefined)
    release!()
    release = undefined
    await until(() => streamClosed)
  })

  test("a reconnect replaces the old connection lease even before it watches again", async () => {
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => conversation !== undefined)
    const old = release!
    release = connectGroupChatClient("window-1")
    old()
    await until(() => streamClosed)
  })

  test("relays a second turn on one subscription even though its frame sequence restarts", async () => {
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
    events.length = 0
    for (const frame of [
      { type: "typing" },
      { type: "turn_start", turnId: 1, frameSeq: 1 },
      { type: "content_chunk", content: "first", seq: 0, frameSeq: 2 },
      { type: "processing_complete" },
      { type: "typing" },
      { type: "turn_start", turnId: 2, frameSeq: 1 },
      { type: "content_chunk", content: "second", seq: 0, frameSeq: 2 },
    ])
      conversation!.enqueue(record(frame))
    await until(() => contents().length === 2)
    expect(contents()).toEqual(["first", "second"])
  })

  test("a typing frame held during the catch-up does not wipe the joined turn", async () => {
    let resume: (() => void) | undefined
    baselineResponse = () =>
      new Promise((resolve) => {
        resume = () =>
          resolve(
            Response.json({
              running: true,
              throughFrameSeq: 2,
              frames: [
                { type: "turn_start", turnId: 7 },
                { type: "content_chunk", content: "first" },
              ],
            }),
          )
      })
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => conversation !== undefined && resume !== undefined)
    conversation!.enqueue(record({ type: "typing" }))
    conversation!.enqueue(record({ type: "turn_start", turnId: 7, frameSeq: 1 }))
    conversation!.enqueue(record({ type: "content_chunk", content: "first", seq: 0, frameSeq: 2 }))
    await Bun.sleep(20)
    resume!()
    await until(() => contents().length === 1)
    conversation!.enqueue(record({ type: "content_chunk", content: " more", seq: 1, frameSeq: 3 }))
    await until(() => contents().length === 2)
    expect(contents()).toEqual(["first", " more"])
    const lastReset = events.findLastIndex((event) => event.properties.reset === true)
    expect(lastReset).toBeLessThan(events.findIndex((event) => event.properties.content === "first"))
  })

  test("a reader's refused turn baseline is not a revocation", async () => {
    baselineResponse = () => Response.json({ error: "Not allowed", code: "not_allowed" }, { status: 403 })
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => baselines === 1 && events.some((event) => event.type === "jolli.groupChat.changed"))
    conversation!.enqueue(record({ type: "content_chunk", content: "in progress", seq: 0, frameSeq: 1 }))
    conversation!.enqueue(record({ type: "group_message_added", seq: 2 }))
    await Bun.sleep(200)
    expect(events.some((event) => event.type === "jolli.groupChat.revoked")).toBe(false)
    expect(events.some((event) => event.type === "jolli.groupChat.answer")).toBe(false)
    expect(streamClosed).toBe(false)
  })

  test("a direct stream's named session_revoked event revokes the chat", async () => {
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => baselines === 1)
    conversation!.enqueue(
      encoder.encode(`event: session_revoked\ndata: ${JSON.stringify({ timestamp: "now", reason: "removed" })}\n\n`),
    )
    await until(() => events.some((event) => event.type === "jolli.groupChat.revoked"))
    expect(events.find((event) => event.type === "jolli.groupChat.revoked")?.properties.chatID).toBe(id)
    await until(() => streamClosed)
  })

  test("reconnects at once, without growing the backoff, each time the server asks", async () => {
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => streams === 1 && baselines === 1)
    conversation!.enqueue(record({ type: "conversation_stream_reset" }))
    await until(() => streams === 2 && baselines === 2)
    conversation!.enqueue(record({ type: "conversation_access_changed" }))
    await until(() => streams === 3 && baselines === 3)
  })

  test("an orphaned turn ends the turn with a refresh", async () => {
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
    events.length = 0
    conversation!.enqueue(record({ type: "agent_turn_orphaned" }))
    await until(() => events.some((event) => event.type === "jolli.groupChat.changed"))
  })

  test("a refused ask joins the turn already running", async () => {
    postResponse = () => Response.json({ error: "Busy", code: "agent_busy" }, { status: 409 })
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => baselines === 1 && events.some((event) => event.type === "jolli.groupChat.changed"))
    baselineResponse = () =>
      Response.json({
        running: true,
        throughFrameSeq: 2,
        frames: [
          { type: "turn_start", turnId: 5 },
          { type: "content_chunk", content: "theirs" },
        ],
      })
    events.length = 0
    await expect(
      sendGroupChatMessage(id, { message: "help", clientRequestId: "r2", mentionedAssistantId: 21 }),
    ).rejects.toMatchObject({ code: "agent_busy" })
    await until(() => contents().includes("theirs"))
    conversation!.enqueue(record({ type: "content_chunk", content: " too", seq: 1, frameSeq: 3 }))
    await until(() => contents().includes(" too"))
  })

  test("an ask refused in its stream without a code is a refusal, not a lost send", async () => {
    postResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(record({ type: "error", error: "Failed to generate AI response" }))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    start()
    const refusal = await sendGroupChatMessage(id, {
      message: "help",
      clientRequestId: "r-refused",
      mentionedAssistantId: 21,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(groupChatFailure(refusal)).toEqual({ status: "refused", code: "message_refused" })
  })

  test("an ask whose stream breaks re-joins its turn on the subscription with one refresh", async () => {
    postResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(record({ type: "message_received" }))
            controller.enqueue(record({ type: "turn_start", turnId: 9, frameSeq: 1 }))
            controller.enqueue(record({ type: "content_chunk", content: "mine", seq: 0, frameSeq: 2 }))
            // Cut off mid-turn: the stream ends without the turn's terminal frame.
            setTimeout(() => controller.close(), 20)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    start()
    groupChatAccess(id, "participant")
    await watchGroupChat(id, "window-1", true)
    await until(() => baselines === 1 && events.some((event) => event.type === "jolli.groupChat.changed"))
    baselineResponse = () =>
      Response.json({
        running: true,
        throughFrameSeq: 2,
        frames: [
          { type: "turn_start", turnId: 9 },
          { type: "content_chunk", content: "mine" },
        ],
      })
    events.length = 0
    await sendGroupChatMessage(id, { message: "help", clientRequestId: "r3", mentionedAssistantId: 21 })
    await until(() => baselines === 2 && contents().filter((content) => content === "mine").length === 2)
    conversation!.enqueue(record({ type: "content_chunk", content: " more", seq: 1, frameSeq: 3 }))
    await until(() => contents().includes(" more"))
    await Bun.sleep(170)
    expect(events.filter((event) => event.type === "jolli.groupChat.changed")).toHaveLength(1)
  })

  test("reads named events, skips comments and non-JSON data, and gives up on a silent stream", async () => {
    const named = new Response(
      `event: session_revoked\ndata: {"reason":"revoked"}\n\n: ping\n\ndata: [ERROR]\n\ndata: {"type":"typing","seq":"x"}\n\n`,
    )
    expect(await Array.fromAsync(readFrames(named))).toEqual([{ type: "session_revoked" }, { type: "typing" }])
    const alive = new Response(
      new ReadableStream({
        async start(controller) {
          for (let ping = 0; ping < 4; ping++) {
            await Bun.sleep(15)
            controller.enqueue(encoder.encode(": ping\n\n"))
          }
          controller.enqueue(record({ type: "processing_complete" }))
          controller.close()
        },
      }),
    )
    expect(await Array.fromAsync(readFrames(alive, 40))).toEqual([{ type: "processing_complete" }])
    const silent = new Response(new ReadableStream({ start() {} }))
    await expect(Array.fromAsync(readFrames(silent, 30))).rejects.toThrow("went silent")
  })

  test("a credential that names no gateway is unreachable, not a sign-out", async () => {
    // The same identity as `start`'s session, whose background reads may still be landing.
    const request = start()
    const credential = {
      id: "student-a",
      cache_key: "a",
      subject: null,
      email: null,
      base_url: null,
      access_token: request.token,
      refresh_token: null,
      token_expiry: null,
      time_created: 1,
      time_updated: 1,
    } satisfies JolliStore.Row
    let reachable = true
    configureGroupChats(
      JolliSession.Service.of({
        current: () => Effect.succeed(credential),
        token: () => Effect.succeed(request.token),
        request: () => Effect.succeed(reachable ? request : undefined),
        refused: () => Effect.succeed(request.token),
        signIn: () => Effect.die(new Error("Unexpected sign in")),
        signOut: () => Effect.void,
      }),
    )
    expect(await watchGroupChat(id, "window-1", true)).toBe(true)
    reachable = false
    const error = await watchGroupChat(id, "window-1", true).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(groupChatFailure(error)).toEqual({ status: "unreachable" })
    expect(events.map((event) => event.type)).not.toContain("jolli.groupChat.reset")
  })

  test("an account-wide notification uses its envelope org and rejects missing or unknown orgs", () => {
    const allowed = new Set(["school:course", "school:other"])
    const notification = {
      type: "notification:created",
      org,
      notification: { type: "group-chat-mention", payload: { recordId: "chat-1" } },
    }
    expect(notificationChat(notification, allowed)).toEqual({ type: "mention", id })
    expect(notificationChat({ ...notification, org: undefined }, allowed)).toBeUndefined()
    expect(notificationChat({ ...notification, org: { ...org, orgSlug: "unknown" } }, allowed)).toBeUndefined()
    expect(
      notificationChat({ type: "chats:changed", convoId: "chat-1", org: { ...org, orgSlug: "other" } }, allowed)?.id,
    ).toBe(groupChatID({ ...org, orgSlug: "other" }, "chat-1"))
  })
})
