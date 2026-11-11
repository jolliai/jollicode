import {
  chatShares,
  voiceRequest,
  downloadChatAttachment,
  uploadChatAttachment,
} from "../src/jolli/group-chat-resources"
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { SessionID } from "@opencode-ai/schema/session-id"
import { groupChatID, parseGroupChatID } from "../src/jolli/org-scoped-id"
import { JolliSignedOut } from "../src/jolli/session"
import {
  accessRevoked,
  groupChatFailure,
  groupEnvironment,
  groupJson,
  knownGroupHome,
  listChats,
  openChat,
  performAction,
  postMessage,
  readChatOpen,
  readFrames,
} from "../src/jolli/group-chat"
import { composerTargetFallback, isAttemptChat, memberActions, replaceAliases } from "../src/jolli/group-chat-rules"
import { safeChatFilename, executableChatFile } from "../src/jolli/group-chat-rules"
import { JolliApiError, type GatewayRequest } from "../src/jolli/api"

const org = { tenantSlug: "school", orgSlug: "course" }
const other = { tenantSlug: "school", orgSlug: "other" }
const id = groupChatID(org, "chat-1")
const group = {
  ownerId: 1,
  participants: [
    { userId: 1, name: "Ana", role: "student", creator: true },
    { userId: 2, name: "Ben", role: "student", creator: false },
  ],
  formerPeople: [],
  aliases: [{ alias: "Student A", userId: 1 }],
  mentionable: [{ id: 21, name: "Tutor" }],
  turns: [],
  composerTargetAssistantId: null,
  lastReadSeq: null,
} as const
let server: ReturnType<typeof Bun.serve> | undefined
const start = (handle: (request: Request) => Response | Promise<Response>): GatewayRequest => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle })
  return { origin: server.url.origin, token: "test-token", identity: crypto.randomUUID() }
}
afterEach(() => {
  server?.stop(true)
  server = undefined
  setSystemTime()
})
const json = (body: unknown, status = 200) => Response.json(body, { status })
const environment = {
  home: org,
  courses: [
    { id: 7, org },
    { id: 8, org: other },
  ],
}

// A group chat can never be passed to a local runner without an explicit unsafe cast.
if (false) {
  const localSessionOnly = (value: SessionID) => value
  // @ts-expect-error GroupChatID is intentionally incompatible with SessionID.
  localSessionOnly(id)
}

describe("server-owned group chats", () => {
  test("brands and round-trips string public IDs with an organization", () => {
    expect(parseGroupChatID(id)).toEqual({ scope: org, publicId: "chat-1" })
    expect(groupChatID(other, "chat-1")).not.toBe(id)
    expect(Schema.is(Jolli.GroupChatID)("chat-1")).toBe(false)
    expect(() => groupChatID(org, "../local-session")).toThrow()
  })

  test.each([undefined, 21])("core adds the source to human and agent messages: %s", async (mentionedAssistantId) => {
    const seen: object[] = []
    const request = start(async (request) => {
      seen.push((await request.json()) as object)
      return json({ turnId: 1, seq: 1 })
    })
    const body = {
      message: "Help",
      clientRequestId: "same-request",
      ...(mentionedAssistantId === undefined ? {} : { mentionedAssistantId }),
      sentFrom: "web",
    }
    const response = await postMessage(request, id, body)
    await response.body?.cancel()
    expect(seen).toEqual([
      {
        message: "Help",
        clientRequestId: "same-request",
        ...(mentionedAssistantId === undefined ? {} : { mentionedAssistantId }),
        sentFrom: "jolli_code",
      },
    ])
  })

  test("keeps busy as a refusal and never retries the write", async () => {
    let calls = 0
    const request = start(() => {
      calls++
      return json({ code: "agent_busy" }, 409)
    })
    await expect(
      postMessage(request, id, { message: "Help", clientRequestId: "busy", mentionedAssistantId: 21 }),
    ).rejects.toMatchObject({ status: 409, code: "agent_busy" })
    expect(calls).toBe(1)
  })

  test("stops the server-owned group answer through its scoped cancel route", async () => {
    const request = start(async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/agent/convos/chat-1/cancel")
      expect(request.method).toBe("POST")
      expect(request.headers.get("authorization")).toBe("Bearer test-token")
      expect(request.headers.get("x-tenant-slug")).toBe(org.tenantSlug)
      expect(request.headers.get("x-org-slug")).toBe(org.orgSlug)
      expect(await request.text()).toBe("")
      return json({ success: true, cancelled: true })
    })
    await Effect.runPromise(performAction(request, id, { type: "cancel" }))
  })

  test("a target without an agent asks the server for the whole group with null", async () => {
    const seen: unknown[] = []
    const request = start(async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/agent/convos/chat-1/composer-target")
      expect(request.method).toBe("PUT")
      seen.push(await request.json())
      return new Response(null, { status: 204 })
    })
    await Effect.runPromise(performAction(request, id, { type: "target" }))
    await Effect.runPromise(performAction(request, id, { type: "target", assistantId: 21 }))
    expect(seen).toEqual([{ assistantId: null }, { assistantId: 21 }])
  })

  test("keeps a refused stop as an action refusal without retrying or revoking the chat", async () => {
    let calls = 0
    const request = start(() => {
      calls++
      return json({ code: "not_allowed" }, 403)
    })
    const error = await Effect.runPromise(performAction(request, id, { type: "cancel" }).pipe(Effect.flip))
    expect(groupChatFailure(error)).toMatchObject({ status: "refused", httpStatus: 403, code: "not_allowed" })
    expect(calls).toBe(1)
  })

  test("opens participants and shared readers, accepts extra fields and keeps home course IDs bare", async () => {
    let reader = false
    const request = start((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/me/courses") return json(environment)
      if (path === "/api/profile") return json({ userId: 1 })
      expect(request.headers.get("x-jolli-org-scope")).toBeNull()
      return json({
        access: reader ? "reader" : "participant",
        [reader ? "transcript" : "detail"]: {
          publicSessionId: "chat-1",
          kind: "group",
          title: "Lab",
          spaceId: 7,
          group: reader ? { participants: group.participants, formerPeople: [], aliases: group.aliases } : group,
          runtime: { isProcessing: true },
          timeline: [
            {
              kind: "message",
              id: 1,
              seq: 1,
              turnId: 1,
              role: "user",
              authorId: 1,
              content: "Hi",
              timestamp: "2026-11-10T00:00:00Z",
              payload: null,
            },
          ],
          futureField: true,
        },
      })
    })
    const participant = await Effect.runPromise(openChat(request, id))
    expect(participant).toMatchObject({ id, viewerId: 1, courseId: "7", access: "participant", processing: true })
    reader = true
    const read = await Effect.runPromise(openChat(request, id))
    expect(read.access).toBe("reader")
    expect(read.group).not.toHaveProperty("turns")
  })

  test("keeps explicit org scope when a refreshed credential changes its home address", async () => {
    const original = start((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/me/courses") return json(environment)
      if (path === "/api/profile") return json({ userId: 1 })
      return json({
        access: "participant",
        detail: { publicSessionId: "chat-1", kind: "group", title: "Lab", spaceId: 7, group, timeline: [] },
      })
    })
    await Effect.runPromise(openChat(original, id))
    await server?.stop(true)
    const destination = start((request) => {
      expect(request.headers.get("x-jolli-org-scope")).toBe("1")
      expect(request.headers.get("x-tenant-slug")).toBe(org.tenantSlug)
      expect(request.headers.get("x-org-slug")).toBe(org.orgSlug)
      return json({ turnId: 1, seq: 1 })
    })
    const response = await postMessage({ ...destination, identity: original.identity }, id, {
      message: "hello",
      clientRequestId: "home-moved",
    })
    await response.body?.cancel()
  })

  test("a remembered course list that misses a newly joined school reads as incomplete and is asked again", async () => {
    const college = { tenantSlug: "college", orgSlug: "main" }
    const reads = { courses: 0 }
    const joined = { college: false }
    const request = start((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/me/courses") {
        reads.courses += 1
        return json({
          home: org,
          courses: [{ id: 7, org }, ...(joined.college ? [{ id: 3, org: college }] : [])],
        })
      }
      if (url.pathname === "/api/auth/session-config") return json({ groupChatsEnabled: true })
      const row = (id: string, at: typeof org, spaceId: number) => ({
        id,
        title: "Lab",
        updatedAt: "2026-11-10T00:00:00Z",
        org: at,
        kind: "group",
        ownership: "owned",
        spaceId,
      })
      return json({
        convos: [row("chat-1", org, 7), ...(joined.college ? [row("chat-2", college, 3)] : [])],
        unavailable: [],
      })
    })
    expect((await Effect.runPromise(listChats(request, undefined))).chats).toHaveLength(1)
    joined.college = true
    // The course list is still the remembered one, which knows nothing of the college.
    const stale = await Effect.runPromise(listChats(request, undefined))
    expect(stale.complete).toBe(false)
    expect(stale.chats.map((chat) => chat.id)).toEqual([groupChatID(org, "chat-1")])
    expect(reads.courses).toBe(1)
    const fresh = await Effect.runPromise(listChats(request, undefined))
    expect(reads.courses).toBe(2)
    expect(fresh.chats.map((chat) => chat.id)).toEqual([groupChatID(org, "chat-1"), groupChatID(college, "chat-2")])
  })

  test("filters the course before the limit and reports incomplete pagination", async () => {
    const request = start((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/me/courses") return json(environment)
      if (url.pathname === "/api/auth/session-config") return json({ groupChatsEnabled: true })
      const row = (n: number, spaceId: number) => ({
        id: `chat-${n}`,
        title: "Lab",
        updatedAt: "2026-11-10T00:00:00Z",
        org,
        kind: "group",
        ownership: "owned",
        spaceId,
      })
      if (!url.searchParams.has("cursor"))
        return json({ convos: Array.from({ length: 64 }, (_, n) => row(n, 7)), unavailable: [], nextCursor: "older" })
      return json({ convos: [row(99, 9)], unavailable: [] })
    })
    const answer = await Effect.runPromise(listChats(request, [{ id: "7" }, { id: "9" }], "9"))
    expect(answer.chats).toHaveLength(1)
    expect(answer.chats[0]).toMatchObject({ id: groupChatID(org, "chat-99"), courseId: "9" })
    expect(answer.complete).toBe(true)
    const limited = await Effect.runPromise(listChats(request, [{ id: "7" }]))
    expect(limited.chats).toHaveLength(64)
    expect(limited.complete).toBe(false)
  })

  test("parses split SSE records and ignores keep-alive comments", async () => {
    const encoder = new TextEncoder()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const part of [
            ':alive\r\n\r\ndata: {"type":"content_',
            'chunk","content":"hello","seq":0}\r\n\r\n',
            'data: {"type":"processing_complete"}\n\n',
          ])
            controller.enqueue(encoder.encode(part))
          controller.close()
        },
      }),
    )
    expect(await Array.fromAsync(readFrames(response))).toEqual([
      { type: "content_chunk", content: "hello", seq: 0 },
      { type: "processing_complete" },
    ])
  })

  test("one read holding many complete frames past the size limit yields them all", async () => {
    const content = "x".repeat(100 * 1024)
    const records = Array.from(
      { length: 30 },
      (_, seq) => `data: ${JSON.stringify({ type: "content_chunk", content, seq })}\n\n`,
    ).join("")
    expect(records.length).toBeGreaterThan(2 * 1024 * 1024)
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(records))
          controller.close()
        },
      }),
    )
    expect((await Array.fromAsync(readFrames(response))).map((frame) => frame.seq)).toEqual(
      Array.from({ length: 30 }, (_, seq) => seq),
    )
  })

  test("one record that grows past the size limit before it ends is refused", async () => {
    const response = new Response(`data: {"type":"content_chunk","content":"${"x".repeat(2 * 1024 * 1024)}`)
    await expect(Array.fromAsync(readFrames(response))).rejects.toThrow("exceeds the size limit")
  })

  test.each([55, "chat-1"])("parses conversation SSE frames with conversation ID %s", async (convoId) => {
    const frames = [
      { type: "group_message_added", convoId, seq: 1 },
      {
        type: "conversation_frames",
        convoId,
        frames: [{ type: "content_chunk", content: "reply", frameSeq: 2 }],
      },
      { type: "processing_complete", convoId },
    ]
    const response = new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""))
    expect(await Array.fromAsync(readFrames(response))).toEqual(frames)
  })

  test("preserves public conversation IDs and organization scopes in notification SSE frames", async () => {
    const frame = { type: "chats:changed", convoId: "chat-1", org }
    expect(await Array.fromAsync(readFrames(new Response(`data: ${JSON.stringify(frame)}\n\n`)))).toEqual([frame])
  })

  test("aliases use the web client's boundaries and one-pass replacement", () => {
    const aliases = [
      { alias: "Student A", userId: 1 },
      { alias: "Student AB", userId: 2 },
    ]
    expect(
      replaceAliases(
        "Student A's answer; Student AB; XStudent A; Student A_",
        aliases,
        new Map([
          [1, "Student AB"],
          [2, "Ben"],
        ]),
      ),
    ).toBe("Student AB's answer; Ben; XStudent A; Student A_")
  })

  test("membership choices keep readers and assignment chats read only", () => {
    const chat = {
      id,
      viewerId: 1,
      title: "Lab",
      courseId: "7",
      access: "participant",
      processing: false,
      group,
      messages: [],
    } satisfies Jolli.GroupChat
    expect(memberActions(chat, 1).remove(2)).toBe(true)
    expect(memberActions(chat, 2).remove(1)).toBe(false)
    expect(memberActions({ ...chat, access: "reader" }, 1).rename).toBe(false)
    expect(isAttemptChat({ ...group, assignmentGroupId: 9 })).toBe(true)
    expect(memberActions({ ...chat, group: { ...group, assignmentGroupId: 9 } }, 1).leave).toBe(false)
    expect(composerTargetFallback(99, group.mentionable)).toBeNull()
  })

  test("peer filenames cannot introduce paths or hidden files", () => {
    expect(safeChatFilename("../..\\startup.sh")).toBe("_.._startup.sh")
    expect(executableChatFile("setup.sh", "text/plain")).toBe(true)
    expect(executableChatFile("notes.txt", "text/plain")).toBe(false)
    for (const name of ["a.scr", "a.vbs", "a.hta", "a.lnk", "a.command", "a.reg", "a.wsf", "a.msix", "a.AppImage"])
      expect(executableChatFile(name, "application/octet-stream")).toBe(true)
    for (const extension of [
      "xla",
      "ppa",
      "dot",
      "xlt",
      "pot",
      "pps",
      "one",
      "onepkg",
      "appinstaller",
      "crt",
      "der",
      "mde",
      "accde",
      "adp",
      "mda",
      "pyo",
      "pyzw",
      "psc2",
      "saver",
      "flatpak",
      "msh",
      "ps2",
      "psd1",
      "sct",
      "shb",
      "shs",
      "vb",
      "bas",
      "website",
      "xnk",
      "mdb",
      "ade",
      "wsb",
      "ppkg",
      "msu",
      "cab",
      "theme",
      "cer",
      "dll",
      "ocx",
      "vsix",
      "pyz",
      "pyc",
      "action",
      "prefpane",
      "snap",
      "flatpakref",
      "xpi",
      "xht",
      "shtml",
      "svgz",
      "xlsb",
      "appref-ms",
      "diagcab",
      "xll",
      "pyw",
      "chm",
      "hlp",
      "msp",
      "mst",
      "gadget",
      "application",
      "xbap",
      "jnlp",
      "scf",
      "wsc",
      "ws",
      "psc1",
      "ps1xml",
      "mht",
      "mhtml",
      "iso",
      "img",
      "vhd",
      "vhdx",
      "desktop",
      "csh",
      "ksh",
      "fish",
      "mpkg",
      "webloc",
      "inetloc",
      "fileloc",
      "library-ms",
      "search-ms",
      "settingcontent-ms",
      "docm",
      "dotm",
      "xlsm",
      "xltm",
      "xlam",
      "pptm",
      "potm",
      "ppam",
      "ppsm",
      "sldm",
    ])
      expect(executableChatFile(`a.${extension.toUpperCase()}`, "application/octet-stream")).toBe(true)
    for (const name of [
      "report.docx",
      "sheet.xlsx",
      "slides.pptx",
      "photo.png",
      "notes.md",
      "essay.doc",
      "data.xls",
      "talk.ppt",
    ])
      expect(executableChatFile(name, "application/octet-stream")).toBe(false)
    // Judged as saved: trailing dots and spaces are stripped on disk, so they cannot hide the extension.
    for (const name of ["setup.exe.", "setup.exe ", "setup.exe. . ", "run.bat..."])
      expect(executableChatFile(name, "application/octet-stream")).toBe(true)
    expect(executableChatFile("installer", "application/x-msdownload")).toBe(true)
    expect(executableChatFile("report.pdf", "application/pdf")).toBe(false)
  })
})

test("voice proxy exposes narration metadata to a renderer on another origin", async () => {
  const request = start(async (request) => {
    expect(request.headers.get("Authorization")).toBe("Bearer test-token")
    expect(await request.json()).toMatchObject({ conversationId: "chat-1", messageId: 4, segment: 0 })
    return new Response("audio", {
      headers: { "Content-Type": "audio/mpeg", "X-Voice-Narration-Version": "v1", "X-Voice-Segment-Count": "2" },
    })
  })
  const incoming = new Request("http://renderer.test/voice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "another-chat", messageId: 4, segment: 0 }),
  })
  const response = await voiceRequest(request, id, incoming, "read-aloud")
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Voice-Narration-Version")
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Voice-Segment-Count")
  expect(response.headers.get("X-Voice-Narration-Version")).toBe("v1")
  expect(await response.text()).toBe("audio")
})

test("peer downloads return the bytes as an attachment and never an executable response", async () => {
  const request = start((request) =>
    new URL(request.url).pathname.endsWith("/attachment-urls")
      ? Response.json({ urls: { "10": `${server!.url.origin}/bytes` } })
      : new Response("untrusted file bytes", { headers: { "Content-Type": "application/javascript" } }),
  )
  const response = await downloadChatAttachment(request, id, 10, "../startup.js")
  expect(response.headers.get("Content-Type")).toBe("application/octet-stream")
  expect(response.headers.get("Content-Disposition")).toContain("attachment;")
  expect(response.headers.get("Content-Disposition")).not.toContain("../")
  expect(await response.text()).toBe("untrusted file bytes")
})

test("peer downloads pass bytes through as they arrive, and a source that stops sending ends the download", async () => {
  const encoder = new TextEncoder()
  let finish: (() => void) | undefined
  const request = start((request) => {
    if (new URL(request.url).pathname.endsWith("/attachment-urls"))
      return Response.json({ urls: { "10": `${server!.url.origin}/bytes`, "11": `${server!.url.origin}/stalled` } })
    const stalled = new URL(request.url).pathname === "/stalled"
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("first "))
          finish = () => {
            controller.enqueue(encoder.encode("last"))
            controller.close()
          }
          if (stalled) finish = undefined
        },
      }),
    )
  })
  const streaming = await downloadChatAttachment(request, id, 10, "notes.txt", undefined, 1000)
  const reader = streaming.body!.getReader()
  const decoder = new TextDecoder()
  // The first bytes are readable while the source is still sending the rest.
  expect(decoder.decode((await reader.read()).value)).toBe("first ")
  finish!()
  const rest: string[] = []
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest.push(decoder.decode(chunk.value))
  expect(rest.join("")).toBe("last")
  const stalled = await downloadChatAttachment(request, id, 11, "notes.txt", undefined, 50)
  await expect(stalled.text()).rejects.toBeDefined()
})

describe("group chat answers", () => {
  const detail = { kind: "group", title: "Lab", spaceId: 7, group, timeline: [] }
  const opening = (open: () => Response, aside: Record<string, () => Response> = {}) =>
    start((request) => {
      const path = new URL(request.url).pathname
      if (aside[path]) return aside[path]()
      if (path === "/api/me/courses") return json(environment)
      if (path === "/api/profile") return json({ userId: 1 })
      if (path === "/api/agent/convos/chat-1/open") return open()
      return json({ error: "Not found" }, 404)
    })
  const failure = (request: GatewayRequest) =>
    Effect.runPromise(openChat(request, id).pipe(Effect.flip)).then((error) => groupChatFailure(error, id))

  test("only the chat's own open read answering 403 or 404 means access is gone", async () => {
    expect(await failure(opening(() => json({ error: "Forbidden" }, 403)))).toEqual({
      status: "revoked",
      httpStatus: 403,
      message: "Forbidden",
    })
    expect(await failure(opening(() => json({ error: "Conversation not found" }, 404)))).toMatchObject({
      status: "revoked",
      httpStatus: 404,
    })
  })

  test("a school sign-in requirement on the open read is a refusal, not a loss of access", async () => {
    expect(await failure(opening(() => json({ error: "sso_required", code: "sso_required" }, 403)))).toEqual({
      status: "refused",
      code: "sso_required",
      httpStatus: 403,
    })
    expect(await failure(opening(() => json({ error: "sso_required" }, 403)))).toMatchObject({
      status: "refused",
      code: "sso_required",
    })
  })

  test("side requests an open makes never revoke the chat", async () => {
    const request = opening(() => json({ access: "participant", detail }), {
      "/api/me/courses": () => json({ error: "Not found" }, 404),
    })
    const chat = await Effect.runPromise(openChat(request, id))
    expect(chat.access).toBe("participant")
    expect(chat.courseId).toBe("school:course:7")
  })

  test("a viewer lookup that fails opens the chat without a viewer, and the next open fills it in", async () => {
    let profile = () => json({ error: "Forbidden" }, 403)
    const request = opening(() => json({ access: "participant", detail }), { "/api/profile": () => profile() })
    const first = await Effect.runPromise(openChat(request, id))
    expect(first.viewerId).toBeNull()
    expect(first.messages).toEqual([])
    profile = () => json({ userId: 2 })
    expect((await Effect.runPromise(openChat(request, id))).viewerId).toBe(2)
  })

  test("a gate in front of the chat on its open read is a refusal, not a loss of access", async () => {
    // jolliedu answers every tenant resolution failure alike, on purpose: it names no chat.
    expect(await failure(opening(() => json({ error: "tenant_resolution_failed" }, 403)))).toEqual({
      status: "refused",
      code: "tenant_resolution_failed",
      httpStatus: 403,
    })
    const revokedCheck = new JolliApiError({
      path: "/api/mercure/conversation-access",
      status: 404,
      code: "conversation_access_revoked",
      message: "Group chat request failed: 404",
    })
    expect(accessRevoked(revokedCheck)).toBe(true)
    expect(groupChatFailure(revokedCheck).status).toBe("revoked")
    // A bare 404 counts only on the chat's own open read, and only as jolliedu's own answer.
    const elsewhere = new JolliApiError({
      path: "/api/agent/convos/chat-1/stream",
      status: 404,
      fromGateway: true,
      message: "Not found",
    })
    expect(accessRevoked(elsewhere, id)).toBe(false)
    const own = new JolliApiError({
      path: "/api/agent/convos/chat-1/open",
      status: 404,
      fromGateway: true,
      message: "Not found",
    })
    expect(accessRevoked(own, id)).toBe(true)
    const page = new JolliApiError({ path: "/api/agent/convos/chat-1/open", status: 404, message: "Not found" })
    expect(accessRevoked(page, id)).toBe(false)
  })

  test("a 403 or 404 page from something in front of jolliedu on the open read is no loss of access", async () => {
    // A WAF or CDN block page, an ingress that lost the route, and a proxy's JSON that is not jolliedu's error:
    // none is the chat's word, so the chat reads again rather than being lost or refused for good.
    const html = (status: number) =>
      new Response("<html><body>Access denied</body></html>", { status, headers: { "content-type": "text/html" } })
    expect(await failure(opening(() => html(403)))).toEqual({ status: "unreachable" })
    expect(await failure(opening(() => html(404)))).toEqual({ status: "unreachable" })
    expect(await failure(opening(() => json({ message: "Forbidden" }, 403)))).toEqual({ status: "unreachable" })
    // The same words as plain text are not jolliedu's JSON either.
    const text = new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { "content-type": "text/plain" },
    })
    expect(await failure(opening(() => text))).toEqual({ status: "unreachable" })
    // A coded refusal is still read for what it says.
    expect(await failure(opening(() => json({ error: "sso_required" }, 403)))).toMatchObject({ status: "refused" })
  })

  test("concurrent identical open reads share one request, and nothing is kept once it settles", async () => {
    let reads = 0
    let answer: (() => void) | undefined
    const request = opening(() => json({ error: "Not found" }, 404), {
      "/api/agent/convos/chat-1/open": () => {
        reads++
        return new Promise<Response>((resolve) => {
          answer = () => resolve(json({ access: "participant", detail }))
        }) as unknown as Response
      },
    })
    // The home is known first, so every caller addresses the chat alike.
    await groupEnvironment(request)
    const together = [
      Effect.runPromise(openChat(request, id, "1")),
      readChatOpen(request, id),
      chatShares(request, id, "1").catch(() => undefined),
    ]
    await Bun.sleep(30)
    expect(reads).toBe(1)
    answer!()
    const [chat, opened] = await Promise.all(together)
    expect(chat).toMatchObject({ access: "participant", courseId: "7" })
    expect(opened).toMatchObject({ access: "participant" })
    // Settled: the next read asks again, so a revocation since is never answered from it.
    const next = readChatOpen(request, id)
    await Bun.sleep(30)
    expect(reads).toBe(2)
    answer!()
    await next
  })

  test("a read kept offline joins only a read made under the same offline version", async () => {
    let reads = 0
    const answers: (() => void)[] = []
    const request = opening(() => json({ error: "Not found" }, 404), {
      "/api/agent/convos/chat-1/open": () => {
        reads++
        return new Promise<Response>((resolve) => {
          answers.push(() => resolve(json({ access: "participant", detail })))
        }) as unknown as Response
      },
    })
    await groupEnvironment(request)
    // The copy was invalidated after the first read set out: the second must not take its answer.
    const before = readChatOpen(request, id, undefined, 1)
    const after = readChatOpen(request, id, undefined, 2)
    const same = readChatOpen(request, id, undefined, 2)
    // A caller that keeps nothing joins whichever read is under way.
    const plain = readChatOpen(request, id)
    await Bun.sleep(30)
    expect(reads).toBe(2)
    answers.forEach((resolve) => resolve())
    await Promise.all([before, after, same, plain])
  })

  test("a caller that leaves stops waiting without cancelling the read the others share", async () => {
    let answer: (() => void) | undefined
    const request = opening(() => json({ error: "Not found" }, 404), {
      "/api/agent/convos/chat-1/open": () =>
        new Promise<Response>((resolve) => {
          answer = () => resolve(json({ access: "reader", transcript: detail }))
        }) as unknown as Response,
    })
    await groupEnvironment(request)
    const leaving = new AbortController()
    const left = readChatOpen(request, id, leaving.signal).catch((error: unknown) => error)
    const staying = readChatOpen(request, id)
    await Bun.sleep(30)
    leaving.abort(new Error("left"))
    expect(await left).toMatchObject({ message: "left" })
    answer!()
    expect(await staying).toMatchObject({ access: "reader" })
  })

  test("an open read is joined only under the same token, and is cancelled once every caller has left", async () => {
    const tokens: (string | null)[] = []
    let cancelled = 0
    const answers: (() => void)[] = []
    const request = start((incoming) => {
      const path = new URL(incoming.url).pathname
      if (path === "/api/me/courses") return json(environment)
      if (path !== "/api/agent/convos/chat-1/open") return json({ error: "Not found" }, 404)
      tokens.push(incoming.headers.get("authorization"))
      incoming.signal.addEventListener("abort", () => cancelled++)
      return new Promise<Response>((resolve) => answers.push(() => resolve(json({ access: "participant", detail }))))
    })
    await groupEnvironment(request)
    // A 401 retry carries the renewed token, and never takes the answer to the one that was refused.
    const refused = readChatOpen(request, id)
    const renewed = readChatOpen({ ...request, token: "renewed-token" }, id)
    await Bun.sleep(30)
    expect(tokens).toEqual(["Bearer test-token", "Bearer renewed-token"])
    answers.forEach((answer) => answer())
    await Promise.all([refused, renewed])
    // Two callers share a read; it runs on while either of them still waits.
    const callers = [new AbortController(), new AbortController()]
    const left = callers.map((caller) => readChatOpen(request, id, caller.signal).catch((error: unknown) => error))
    await Bun.sleep(30)
    expect(tokens).toHaveLength(3)
    callers[0].abort(new Error("left"))
    await Bun.sleep(30)
    expect(cancelled).toBe(0)
    callers[1].abort(new Error("left"))
    expect(await Promise.all(left)).toMatchObject([{ message: "left" }, { message: "left" }])
    const end = Date.now() + 1500
    while (cancelled === 0 && Date.now() < end) await Bun.sleep(5)
    expect(cancelled).toBe(1)
    // The cancelled read is gone: the next caller asks afresh rather than joining it.
    const next = readChatOpen(request, id)
    await Bun.sleep(30)
    expect(tokens).toHaveLength(4)
    answers.at(-1)!()
    expect(await next).toMatchObject({ access: "participant" })
  })

  test("the credential's subject names the viewer without asking for the profile", async () => {
    const seen: string[] = []
    const request = start((request) => {
      const path = new URL(request.url).pathname
      seen.push(path)
      if (path === "/api/me/courses") return json(environment)
      return json({ access: "participant", detail })
    })
    expect((await Effect.runPromise(openChat(request, id, "42"))).viewerId).toBe(42)
    await Effect.runPromise(openChat(request, id, "42"))
    expect(seen).not.toContain("/api/profile")
    expect(seen.filter((path) => path === "/api/me/courses")).toHaveLength(1)
  })

  test("timeline items of unknown kinds are skipped and unknown roles and turn modes are kept", async () => {
    const request = opening(() =>
      json({
        access: "participant",
        detail: {
          ...detail,
          group: {
            ...group,
            participants: [{ userId: 1, name: "Ana", role: "teaching_assistant" }],
            turns: [{ turnId: 1, mode: "future_mode", assistantId: null, askerId: 1, triggerSeq: null }],
          },
          timeline: [
            { kind: "future_card", id: 9 },
            {
              kind: "message",
              id: 1,
              seq: 1,
              turnId: 1,
              role: "user",
              content: "Hi",
              timestamp: "2026-11-10T00:00:00Z",
            },
          ],
        },
      }),
    )
    const chat = await Effect.runPromise(openChat(request, id))
    expect(chat.messages.map((message) => message.id)).toEqual([1])
    expect(chat.group.participants[0].role).toBe("teaching_assistant")
  })

  test("an action's 403 is a refusal with its code and status, even naming the chat", async () => {
    const request = start(() => json({ error: "Readers cannot write", code: "not_allowed" }, 403))
    const error = await Effect.runPromise(performAction(request, id, { type: "read", seq: 1 }).pipe(Effect.flip))
    const refused = {
      status: "refused",
      code: "not_allowed",
      httpStatus: 403,
      message: "Readers cannot write",
    } as const
    expect(groupChatFailure(error)).toEqual(refused)
    expect(groupChatFailure(error, id)).toEqual(refused)
  })

  test("sign-outs, outages and in-stream refusals keep their own meanings", () => {
    expect(groupChatFailure(new JolliApiError({ path: "/x", status: 401, message: "Expired" }))).toEqual({
      status: "signed-out",
      httpStatus: 401,
    })
    expect(groupChatFailure(new JolliSignedOut({ message: "Sign in again" }))).toEqual({ status: "signed-out" })
    expect(groupChatFailure(new JolliApiError({ path: "/x", status: 503, message: "Down" }))).toEqual({
      status: "unreachable",
    })
    expect(groupChatFailure(new JolliApiError({ path: "/x", message: "No response" }))).toEqual({
      status: "unreachable",
    })
    expect(groupChatFailure(new JolliApiError({ path: "/x", code: "agent_busy", message: "Busy" }))).toEqual({
      status: "refused",
      code: "agent_busy",
    })
    expect(groupChatFailure(new Error("Unexpected"))).toEqual({ status: "unreachable" })
  })

  test("a body that stops arriving is no response, while a malformed one is not", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("Connection reset"))
        },
      }),
    )
    const interrupted = await groupJson(broken, "/open").catch((error) => error)
    expect(interrupted).toBeInstanceOf(JolliApiError)
    expect(interrupted).toMatchObject({ path: "/open" })
    expect(interrupted instanceof JolliApiError && interrupted.status).toBeUndefined()
    const malformed = await groupJson(new Response("{"), "/open").catch((error) => error)
    expect(malformed).not.toBeInstanceOf(JolliApiError)
  })
})

describe("group chat lists that cannot be complete", () => {
  const row = { id: "chat-5", title: "Lab", updatedAt: "2026-11-10T00:00:00Z", org, kind: "group", ownership: "owned" }
  const listing = (courses: unknown, convos: unknown) =>
    start((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/me/courses") return json(courses)
      if (path === "/api/auth/session-config") return json({ groupChatsEnabled: true })
      return json(convos)
    })

  test("an unreadable catalogue keeps each row's own course and never reports a complete list", async () => {
    const request = listing(environment, { convos: [{ ...row, spaceId: 7 }], unavailable: [] })
    const answer = await Effect.runPromise(listChats(request, undefined, "7"))
    expect(answer.chats.map((chat) => chat.courseId)).toEqual(["7"])
    expect(answer.complete).toBe(false)
  })

  test("a course the catalogue does not name lists nothing and never reports a complete list", async () => {
    const request = listing(environment, { convos: [{ ...row, spaceId: 7 }], unavailable: [] })
    const answer = await Effect.runPromise(listChats(request, [{ id: "8" }], "7"))
    expect(answer.chats).toEqual([])
    expect(answer.complete).toBe(false)
  })

  test("an org the course list could not reach makes the list incomplete", async () => {
    const request = listing(
      { ...environment, unavailable: [other] },
      { convos: [{ ...row, spaceId: 7 }], unavailable: [] },
    )
    const answer = await Effect.runPromise(listChats(request, [{ id: "7" }]))
    expect(answer.chats).toHaveLength(1)
    expect(answer.complete).toBe(false)
  })

  test("a row whose id cannot be addressed is skipped without failing the list", async () => {
    const request = listing(environment, {
      convos: [
        { ...row, id: "bad.id", spaceId: 7 },
        { ...row, spaceId: 7 },
      ],
      unavailable: [],
    })
    const answer = await Effect.runPromise(listChats(request, [{ id: "7" }]))
    expect(answer.chats.map((chat) => chat.id)).toEqual([groupChatID(org, "chat-5")])
    expect(answer.complete).toBe(true)
  })

  test("a list that pages on past the cap stops and reports itself incomplete", async () => {
    let pages = 0
    const request = start((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/me/courses") return json(environment)
      if (path === "/api/auth/session-config") return json({ groupChatsEnabled: true })
      pages += 1
      return json({ convos: [{ ...row, kind: "direct" }], unavailable: [], nextCursor: `page-${pages}` })
    })
    const answer = await Effect.runPromise(listChats(request, [{ id: "7" }]))
    expect(pages).toBe(5)
    expect(answer.complete).toBe(false)
  })

  test("reads the course list and the first page together, and each school's switch once in a while", async () => {
    let configs = 0
    let configFails = false
    let pageAsked: (() => void) | undefined
    const pageSeen = new Promise<void>((resolve) => (pageAsked = resolve))
    const request = start(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/me/courses") {
        // Answers only once the first page has been asked for, which a list read in turn never does.
        await Promise.race([pageSeen, Bun.sleep(1000).then(() => Promise.reject(new Error("Read in turn")))])
        return json(environment)
      }
      if (path === "/api/auth/session-config") {
        configs++
        return configFails ? json({ error: "Down" }, 503) : json({ groupChatsEnabled: true })
      }
      pageAsked?.()
      return json({ convos: [{ ...row, spaceId: 7 }], unavailable: [] })
    })
    const first = await Effect.runPromise(listChats(request, [{ id: "7" }]))
    expect(first.chats).toHaveLength(1)
    expect(first.complete).toBe(true)
    configFails = true
    // A remembered switch still makes a complete list while the school cannot be asked.
    const second = await Effect.runPromise(listChats(request, [{ id: "7" }]))
    expect(second.complete).toBe(true)
    expect(configs).toBe(1)
  })

  test.each([
    ["answers 404", () => json({ error: "Not found" }, 404)],
    ["answers a config without the switch", () => json({ voice: { input: true, readAloud: false } })],
    ["cannot be read", () => json({ error: "Down" }, 503)],
  ])(
    "a school that %s is off for this read, leaves the list incomplete and is asked again only after a minute",
    async (_, config) => {
      let configs = 0
      const request = start((request) => {
        const path = new URL(request.url).pathname
        if (path === "/api/me/courses") return json(environment)
        if (path === "/api/auth/session-config") {
          configs++
          return config()
        }
        return json({ convos: [{ ...row, spaceId: 7 }], unavailable: [] })
      })
      const now = Date.now()
      setSystemTime(now)
      const answer = await Effect.runPromise(listChats(request, [{ id: "7" }]))
      expect(answer.chats).toEqual([])
      // Complete, it would purge the school's offline copies.
      expect(answer.complete).toBe(false)
      // Every message nudge reads the list again: the school is not asked each time, and the list stays incomplete.
      const nudged = await Effect.runPromise(listChats(request, [{ id: "7" }]))
      expect(nudged.complete).toBe(false)
      expect(configs).toBe(1)
      setSystemTime(now + 60_001)
      await Effect.runPromise(listChats(request, [{ id: "7" }]))
      expect(configs).toBe(2)
    },
  )
})

describe("the home org", () => {
  test("a snapshot without a home is asked again later, and a course list read names the home at once", async () => {
    const request = start(() => json(environment))
    expect(await knownGroupHome(request)).toBeUndefined()
    expect(await knownGroupHome(request)).toBeUndefined()
    await groupEnvironment(request)
    expect(await knownGroupHome(request)).toEqual(org)
  })
})

describe("peer filenames", () => {
  test.each([
    ["CON", "_CON"],
    ["nul.txt", "_nul.txt"],
    ["com1.log", "_com1.log"],
    ["console.txt", "console.txt"],
    ['a<b>c:d"e|f?g*h.txt', "a_b_c_d_e_f_g_h.txt"],
    ["report.pdf. . ", "report.pdf"],
    ["...", "attachment"],
    [" .bashrc", "bashrc"],
    ["invoice\u202Etxt.exe", "invoice_txt.exe"],
    ["bad\uD800name.txt", "bad_name.txt"],
  ])("makes %j safe on every desktop system", (name, expected) => {
    expect(safeChatFilename(name)).toBe(expected)
  })

  test("cuts long names by code point, keeps the extension and stays encodable", () => {
    // A cut by UTF-16 unit would land between the first emoji's two halves.
    const safe = safeChatFilename(`${"a".repeat(155)}\u{1F600}\u{1F600}tail.pdf`)
    expect(safe).toBe(`${"a".repeat(155)}\u{1F600}.pdf`)
    expect(Array.from(safe)).toHaveLength(160)
    expect(() => encodeURIComponent(safe)).not.toThrow()
    expect(safeChatFilename(`${"\u{1F600}".repeat(200)}`)).toBe("\u{1F600}".repeat(160))
  })
})

describe("attachment uploads", () => {
  const uploading = (seen: { length?: string | null; chunked?: string | null; bytes?: number }) =>
    start(async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/attachments/upload-ticket")
        return json({
          kind: "upload",
          ticket: {
            url: `${server!.url.origin}/bucket`,
            objectKey: "key",
            requiredHeaders: { "Content-Type": "text/plain", "If-None-Match": "*" },
            attachmentId: 3,
          },
        })
      if (path === "/bucket") {
        seen.length = request.headers.get("content-length")
        seen.chunked = request.headers.get("transfer-encoding")
        seen.bytes = (await request.arrayBuffer().catch(() => new ArrayBuffer(0))).byteLength
        return new Response(null, { status: 200 })
      }
      return json({ id: 3 })
    })
  const incoming = (size: number) =>
    new Request("http://renderer.test/attachment", {
      method: "POST",
      headers: {
        "x-filename": encodeURIComponent("notes.txt"),
        "x-file-size": String(size),
        "content-type": "text/plain",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"))
          controller.enqueue(new TextEncoder().encode(" world"))
          controller.close()
        },
      }),
      duplex: "half",
    } as RequestInit)

  test("sends the declared length the upload ticket signed, never a chunked body", async () => {
    const seen: { length?: string | null; chunked?: string | null; bytes?: number } = {}
    const request = uploading(seen)
    expect(await uploadChatAttachment((run) => run(request), id, incoming(11))).toEqual({ id: 3 })
    expect(seen).toEqual({ length: "11", chunked: null, bytes: 11 })
  })

  test.each([20, 3])("refuses a body that is not the declared %i bytes", async (size) => {
    const request = uploading({})
    await expect(uploadChatAttachment((run) => run(request), id, incoming(size))).rejects.toMatchObject({
      status: 400,
      code: "size_mismatch",
    })
  })

  test("a refusal after the bytes went out renews and retries the registration alone", async () => {
    const calls: string[] = []
    const request = start(async (request) => {
      const path = new URL(request.url).pathname
      calls.push(path)
      if (path === "/api/attachments/upload-ticket")
        return json({
          kind: "upload",
          ticket: { url: `${server!.url.origin}/bucket`, objectKey: "key", requiredHeaders: {}, attachmentId: 3 },
        })
      if (path === "/bucket") {
        await request.arrayBuffer()
        return new Response(null, { status: 200 })
      }
      return request.headers.get("authorization") === "Bearer renewed-token"
        ? json({ id: 3 })
        : json({ error: "Unauthorized" }, 401)
    })
    const authorized = <A>(run: (request: GatewayRequest) => Promise<A>) =>
      run(request).catch((error: unknown) => {
        if (!(error instanceof JolliApiError) || error.status !== 401) throw error
        return run({ ...request, token: "renewed-token" })
      })
    expect(await uploadChatAttachment(authorized, id, incoming(11))).toEqual({ id: 3 })
    expect(calls).toEqual([
      "/api/attachments/upload-ticket",
      "/bucket",
      "/api/attachments/3/register",
      "/api/attachments/3/register",
    ])
  })
})
