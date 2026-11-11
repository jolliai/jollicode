import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createServer } from "node:http"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerSDK } from "@/context/server-sdk"
import { createSdkForServer } from "@/utils/server"
import {
  changeGroupChat,
  groupChatFetch,
  useGroupChatAttachments,
  type ChatAttachment,
  type GroupChatAttachmentDraft,
} from "./group-chat-media"

const chatID = Jolli.GroupChatID.make("school:course:chat-1")
const pending: ChatAttachment = { id: 4, filename: "notes.pdf", mimeType: "application/pdf", state: "pending" }
const ready: ChatAttachment = { ...pending, state: "available", index: { status: "ready" } }

/**
 * A sidecar that answers each attachment status read with the next answer in `answers`. `signOut` hears a read
 * that answered the credential is gone.
 */
function following(answers: Array<() => Promise<{ data: unknown }>>, signOut?: () => void) {
  const reads = { count: 0 }
  const sdk = {
    client: {
      jolli: {
        groupChatAttachmentStatus: () => answers[Math.min(reads.count++, answers.length - 1)](),
      },
    },
  } as unknown as ServerSDK
  // A chip whose bytes arrived and that the server is still processing, as a reopened chat holds it.
  const draft = createStore<GroupChatAttachmentDraft>({
    files: [{ key: "chip", name: pending.filename, progress: 80, failed: false, attachment: pending }],
    materials: [],
    error: false,
  })
  const root = createRoot((dispose) => ({
    attachments: useGroupChatAttachments(
      () => sdk,
      () => chatID,
      draft,
      signOut,
    ),
    dispose,
  }))
  disposers.push(root.dispose)
  return { chip: () => draft[0].files[0], reads, attachments: root.attachments }
}

const disposers: Array<() => void> = []

/** Lets the follow loop take its next poll: the wait between polls, then the read's promise chain. */
async function poll(ms = 1500) {
  jest.advanceTimersByTime(ms)
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe("following an uploaded group chat attachment", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    disposers.splice(0).forEach((dispose) => dispose())
    jest.useRealTimers()
  })

  test("a status read that gets no answer keeps following the file until it is ready", async () => {
    const follow = following([
      () => Promise.reject(new Error("connection lost")),
      async () => ({ data: { status: "unreachable", httpStatus: 503 } }),
      async () => ({ data: { status: "ok", resource: ready } }),
    ])
    await poll()
    await poll()
    expect(follow.chip()).toMatchObject({ progress: 80, failed: false, attachment: pending })
    await poll()
    expect(follow.reads.count).toBe(3)
    expect(follow.chip()).toMatchObject({ progress: 100, failed: false, attachment: ready })
  })

  test("the attachment route answering that the file is gone marks it failed at once", async () => {
    // jolliedu's own 404 for the file: a JSON error the sidecar passes on as the message, with no code.
    const follow = following([
      async () => ({ data: { status: "refused", httpStatus: 404, message: "No such attachment" } }),
    ])
    await poll()
    expect(follow.reads.count).toBe(1)
    expect(follow.chip()).toMatchObject({ progress: 100, failed: true })
  })

  test("losing the chat marks the file failed at once", async () => {
    const follow = following([async () => ({ data: { status: "revoked", httpStatus: 404 } })])
    await poll()
    expect(follow.chip()).toMatchObject({ progress: 100, failed: true })
  })

  test("a refusal of the poll rather than the file keeps following it until it is ready", async () => {
    const follow = following([
      // An org the request could not be placed in, and a 404 a proxy answered with a page of its own.
      async () => ({ data: { status: "refused", code: "tenant_resolution_failed", httpStatus: 403 } }),
      async () => ({ data: { status: "refused", httpStatus: 404 } }),
      async () => ({ data: { status: "refused", httpStatus: 403, message: "Forbidden" } }),
      async () => ({ data: { status: "refused", code: "sso_required", httpStatus: 403 } }),
      async () => ({ data: { status: "signed-out", httpStatus: 401 } }),
      async () => ({ data: { status: "ok", resource: ready } }),
    ])
    for (let read = 0; read < 5; read++) await poll()
    expect(follow.reads.count).toBe(5)
    expect(follow.chip()).toMatchObject({ progress: 80, failed: false, attachment: pending })
    await poll()
    expect(follow.chip()).toMatchObject({ progress: 100, failed: false, attachment: ready })
  })

  test("a status read answering signed out signs the window out and says nothing about the file", async () => {
    const signOuts: string[] = []
    const follow = following(
      [
        async () => ({ data: { status: "signed-out", httpStatus: 401 } }),
        async () => ({ data: { status: "ok", resource: ready } }),
      ],
      () => signOuts.push("signed out"),
    )
    await poll()
    expect(signOuts).toEqual(["signed out"])
    // The window's drop clears the chip with the page; until then the file is neither failed nor ready.
    expect(follow.chip()).toMatchObject({ progress: 80, failed: false, attachment: pending })
    await follow.attachments.recheck()
    expect(signOuts).toEqual(["signed out"])
  })

  test("a recheck after a refused message marks only the files the server says are gone", async () => {
    const follow = following([
      async () => ({ data: { status: "refused", code: "tenant_resolution_failed", httpStatus: 403 } }),
      async () => ({ data: { status: "refused", httpStatus: 410, message: "Gone" } }),
    ])
    // Asked before the follow loop's next poll, so each recheck takes the next answer.
    await follow.attachments.recheck()
    expect(follow.chip().failed).toBe(false)
    await follow.attachments.recheck()
    expect(follow.chip().failed).toBe(true)
  })

  test("a rate-limited or timed-out status read is asked again rather than failing the file", async () => {
    const follow = following([
      async () => ({ data: { status: "refused", code: "rate_limited", httpStatus: 429 } }),
      async () => ({ data: { status: "refused", httpStatus: 408 } }),
      async () => ({ data: { status: "ok", resource: ready } }),
    ])
    await poll()
    await poll()
    expect(follow.chip()).toMatchObject({ progress: 80, failed: false, attachment: pending })
    await poll()
    expect(follow.chip()).toMatchObject({ progress: 100, failed: false, attachment: ready })
  })

  test("the file's own failed state marks it failed", async () => {
    const follow = following([
      async () => ({
        data: { status: "ok", resource: { ...pending, state: "available", index: { status: "failed" } } },
      }),
    ])
    await poll()
    expect(follow.chip()).toMatchObject({ progress: 100, failed: true })
  })

  test("a file still waiting on an unreachable server reads as failed once the wait runs out", async () => {
    const follow = following([() => Promise.reject(new Error("connection lost"))])
    await poll()
    expect(follow.chip().failed).toBe(false)
    await poll(10 * 60_000)
    expect(follow.chip()).toMatchObject({ progress: 100, failed: true, attachment: pending })
  })
})

describe("group chat sidecar routes", () => {
  test("a route is joined below the server's address, so a path prefix survives", async () => {
    const seen: string[] = []
    // node:http rather than Bun.serve: the DOM test environment's fetch rejects Bun.serve's responses.
    const server = createServer((request, response) => {
      if (request.method !== "OPTIONS") seen.push(request.url ?? "")
      response.setHeader("Access-Control-Allow-Origin", "*")
      response.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
    const sdkAt = (url: string) => ({ url, server: { http: { url } } }) as unknown as ServerSDK
    try {
      for (const base of [origin, `${origin}/`, `${origin}/sidecar`, `${origin}/sidecar/`])
        await groupChatFetch(sdkAt(base), "/jolli/voice/session?locale=en")
    } finally {
      server.close()
    }
    expect(seen).toEqual([
      "/jolli/voice/session?locale=en",
      "/jolli/voice/session?locale=en",
      "/sidecar/jolli/voice/session?locale=en",
      "/sidecar/jolli/voice/session?locale=en",
    ])
  })

  test("a drop over the limit adds ten chips and uploads them two at a time", async () => {
    const started: string[] = []
    const flight = { now: 0, most: 0 }
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*")
      response.setHeader("Access-Control-Allow-Headers", "*")
      if (request.method === "OPTIONS") return void response.end()
      started.push(decodeURIComponent(String(request.headers["x-filename"])))
      flight.now += 1
      flight.most = Math.max(flight.most, flight.now)
      setTimeout(() => {
        flight.now -= 1
        response.writeHead(500).end()
      }, 20)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
    const sdk = { url, server: { http: { url } } } as unknown as ServerSDK
    const draft = createStore<GroupChatAttachmentDraft>({ files: [], materials: [], error: false })
    const mounted = createRoot((dispose) => ({
      dispose,
      attachments: useGroupChatAttachments(
        () => sdk,
        () => chatID,
        draft,
      ),
    }))
    const names = Array.from({ length: 10 }, (_, index) => `file-${index}.txt`)
    try {
      await mounted.attachments.add([...names, "file-10.txt", "file-11.txt"].map((name) => new File(["x"], name)))
    } finally {
      mounted.dispose()
      server.close()
    }
    expect(draft[0].files.map((chip) => chip.name)).toEqual(names)
    expect(draft[0].error).toBe(true)
    expect(started.toSorted()).toEqual(names.toSorted())
    expect(flight.most).toBe(2)
    expect(draft[0].files.every((chip) => chip.failed)).toBe(true)
  })

  test("only sidecar group chat routes are fetched", () => {
    const sdk = { url: "http://127.0.0.1:1", server: { http: { url: "http://127.0.0.1:1" } } } as unknown as ServerSDK
    expect(() => groupChatFetch(sdk, "/session")).toThrow("Invalid group chat route")
  })
})

describe("changing a group chat", () => {
  /** The generated routes, each recording what it was asked and answering with `answer`. */
  const routes = (answer: () => Promise<{ data: unknown }>) => {
    const calls: Array<[string, unknown]> = []
    const route = (name: string) => (parameters: unknown) => {
      calls.push([name, parameters])
      return answer()
    }
    const sdk = {
      client: {
        jolli: {
          groupChatCancel: route("cancel"),
          groupChatRead: route("read"),
          groupChatTarget: route("target"),
          groupChatRename: route("rename"),
          groupChatAddPeople: route("add"),
          groupChatRemovePerson: route("remove"),
        },
      },
    } as unknown as ServerSDK
    return { sdk, calls }
  }

  test("each action goes through its own route, and pointing at the whole group sends no agent", async () => {
    const { sdk, calls } = routes(async () => ({ data: { status: "ok" } }))
    const actions: Jolli.GroupChatAction[] = [
      { type: "cancel" },
      { type: "read", seq: 12 },
      { type: "target", assistantId: 21 },
      { type: "target" },
      { type: "rename", title: "Lab" },
      { type: "add", userIds: [5, 6] },
      { type: "remove", userId: 5 },
    ]
    for (const action of actions) expect(await changeGroupChat(sdk, chatID, action)).toEqual({ status: "ok" })
    expect(calls).toEqual([
      ["cancel", { chatID }],
      ["read", { chatID, seq: 12 }],
      ["target", { chatID, assistantId: 21 }],
      ["target", { chatID, assistantId: undefined }],
      ["rename", { chatID, title: "Lab" }],
      ["add", { chatID, userIds: [5, 6] }],
      ["remove", { chatID, userId: "5" }],
    ])
  })

  test("on the wire, the whole group is an empty target and an agent is its id", async () => {
    const seen: string[] = []
    const server = createServer(async (request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*")
      response.setHeader("Access-Control-Allow-Methods", "*")
      response.setHeader("Access-Control-Allow-Headers", "*")
      const body = await request.toArray().then((chunks) => chunks.join(""))
      // A cross-origin preflight is answered by the headers alone.
      if (request.method !== "OPTIONS")
        seen.push(`${request.method} ${request.url} ${request.headers["content-type"] ?? ""} ${body}`)
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ status: "ok" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
    const sdk = { client: createSdkForServer({ server: { url }, throwOnError: true }) } as unknown as ServerSDK
    try {
      await changeGroupChat(sdk, chatID, { type: "target" })
      await changeGroupChat(sdk, chatID, { type: "target", assistantId: 21 })
    } finally {
      server.close()
    }
    const route = `PUT /jolli/group-chat/${encodeURIComponent(chatID)}/composer-target application/json`
    expect(seen).toEqual([`${route} {}`, `${route} {"assistantId":21}`])
  })

  test("a request that got no answer throws instead of reading as an answer", async () => {
    const { sdk } = routes(() => Promise.reject(new Error("connection lost")))
    await expect(changeGroupChat(sdk, chatID, { type: "cancel" })).rejects.toThrow("connection lost")
    const empty = routes(async () => ({ data: undefined }))
    await expect(changeGroupChat(empty.sdk, chatID, { type: "cancel" })).rejects.toThrow()
  })
})
