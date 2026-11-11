import { describe, expect, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import { migrateTabs } from "@/context/tab-migration"
import { pushClosedTab, takeClosedTab, removeClosedTabs, type ClosedTab } from "@/context/closed-tabs"
import type { GroupChatTab, SessionTab } from "@/context/tabs"
import { groupChatHref } from "@/utils/session-route"
import { ServerConnection } from "@/context/server"
import { sanitizeMarkdown } from "@opencode-ai/session-ui/markdown-sanitize"
import { voiceWav } from "./voice-wav"
import {
  firstGroupChatLossNotice,
  groupChatMentionNotice,
  groupChatRefusal,
  groupChatRefusalKey,
  groupChatRefusalNeedsRead,
  groupChatRouteId,
  groupMessagePayload,
  runningGroupTurn,
  canStopGroupAnswer,
} from "./group-chat"
import { createVoiceSessions } from "./group-chat-voice"
import { mergeGroupChatRows } from "./group-chat-state"

const server = ServerConnection.Key.make("http://localhost:4096")
const chatID = Jolli.GroupChatID.make("school:course:chat-1")
const group: GroupChatTab = { type: "groupChat", server, chatId: chatID }
const local: SessionTab = { type: "session", server, sessionId: "ses_local" }

describe("stopping a group answer", () => {
  const chat: Jolli.GroupChat = {
    id: chatID,
    title: "Lab",
    courseId: "7",
    viewerId: 1,
    access: "participant",
    processing: true,
    messages: [],
    group: {
      participants: [
        { userId: 1, name: "Asker", role: "student" },
        { userId: 2, name: "Peer", role: "student" },
        { userId: 3, name: "Teacher", role: "staff" },
      ],
      formerPeople: [],
      aliases: [],
      turns: [{ turnId: 10, mode: "agent", assistantId: 21, askerId: 1, triggerSeq: 1 }],
    },
  }

  test("offers stop to the asker and staff after reopening the chat, but not another student", () => {
    expect(canStopGroupAnswer(chat)).toBe(true)
    expect(canStopGroupAnswer({ ...chat, viewerId: 3 })).toBe(true)
    expect(canStopGroupAnswer({ ...chat, viewerId: 2 })).toBe(false)
  })

  test("uses an admitted local question until the next read lists its turn", () => {
    expect(canStopGroupAnswer({ ...chat, viewerId: 2 }, { assistantId: 21, askerId: 2 })).toBe(true)
    expect(canStopGroupAnswer(chat, { assistantId: 21, askerId: 2 })).toBe(false)
  })

  test("offers no stop for readers, an unknown viewer or a finished answer", () => {
    expect(canStopGroupAnswer({ ...chat, access: "reader" })).toBe(false)
    expect(canStopGroupAnswer({ ...chat, viewerId: null })).toBe(false)
    expect(canStopGroupAnswer({ ...chat, processing: false })).toBe(false)
    expect(canStopGroupAnswer(undefined)).toBe(false)
  })
})

describe("group chat navigation and content boundaries", () => {
  test("group tabs round-trip without a directory or a local session ID", () => {
    const href = groupChatHref(server, chatID)
    expect(href).toContain("/group-chat/school%3Acourse%3Achat-1")
    expect(migrateTabs([group, { ...group, chatId: "bare-id" }], server)).toEqual([group])
    expect(group).not.toHaveProperty("sessionId")
    expect(group).not.toHaveProperty("directory")
  })
  test("close and reopen keep group identity while removing local sessions leaves groups intact", () => {
    const closed = pushClosedTab<SessionTab | GroupChatTab>([], group, 1)
    const result = takeClosedTab(closed, [local])
    expect(result.entry).toEqual({ tab: group, index: 1 })
    const stack: ClosedTab<SessionTab | GroupChatTab>[] = [...closed, { tab: local, index: 0 }]
    expect(removeClosedTabs(stack, server, [local.sessionId])).toEqual(closed)
    expect(takeClosedTab(closed, [group]).entry).toBeUndefined()
  })
  test("peer markdown never leaves remotely loaded images, media or tracking styles", () => {
    const html = sanitizeMarkdown(
      '<p>hello</p><img src="https://example.com/pixel?x=1&amp;y=2" alt="diagram"><div style="background-image:url(https://example.com/track)">text</div><video src="https://example.com/video"></video><a href="https://example.com" ping="https://example.com/ping">open</a>',
      true,
    )
    const template = document.createElement("template")
    template.innerHTML = html
    expect(template.content.querySelector("img,video,audio,source,[style],[src],[ping]") === null).toBe(true)
    expect(template.content.querySelector("a")?.getAttribute("href")).toBe("https://example.com/pixel?x=1&y=2")
    expect(template.content.textContent).toContain("diagram")
  })
  test("a peer image turned into a link shows its real address, not only its alt text", () => {
    const template = document.createElement("template")
    template.innerHTML = sanitizeMarkdown('<img src="https://evil.example/x.png" alt="https://school.example">', true)
    expect(template.content.querySelector("a")?.textContent).toBe("https://school.example (https://evil.example/x.png)")
    template.innerHTML = sanitizeMarkdown('<img src="https://example.com/a.png">', true)
    expect(template.content.querySelector("a")?.textContent).toBe("https://example.com/a.png")
  })
  test("peer markdown cannot borrow the app's classes or data attributes", () => {
    const template = document.createElement("template")
    template.innerHTML = sanitizeMarkdown(
      '<div class="fixed inset-0 z-50" data-component="message">fake</div><pre><code class="language-ts hljs">x</code></pre><a class="external-link" href="https://example.com">a</a>',
      true,
    )
    expect(template.content.querySelector("div")?.hasAttribute("class")).toBe(false)
    expect(template.content.querySelector("[data-component]")).toBeNull()
    expect(template.content.querySelector("code")?.getAttribute("class")).toBe("language-ts")
    expect(template.content.querySelector("a")?.getAttribute("class")).toBe("external-link")
  })
  test("a formula in peer markdown keeps KaTeX's classes and nothing borrowed beside them", () => {
    const template = document.createElement("template")
    template.innerHTML = sanitizeMarkdown(
      '<span class="katex-display"><span class="katex"><span class="katex-html" aria-hidden="true"><span class="col-align-l vlist-t fixed inset-0">x</span></span></span></span>',
      true,
    )
    expect(template.content.querySelector(".katex-display > .katex > .katex-html")).not.toBeNull()
    expect(template.content.querySelector(".vlist-t")?.getAttribute("class")).toBe("col-align-l vlist-t")
  })
  test("voice output is mono 16 kHz PCM, including a higher-rate microphone", async () => {
    const blob = voiceWav([new Float32Array([1, 1, 1, -1, -1, -1])], 48000)
    const view = new DataView(await blob.arrayBuffer())
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(4)
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })
})

describe("group chat route ids", () => {
  test("an encoded org-scoped id opens; anything else is not found instead of throwing", () => {
    expect(groupChatRouteId("school%3Acourse%3Achat-1")).toBe(chatID)
    expect(groupChatRouteId("school:course:chat-1")).toBe(chatID)
    expect(groupChatRouteId("%E0%A4%A")).toBeUndefined()
    expect(groupChatRouteId("bare-id")).toBeUndefined()
    expect(groupChatRouteId("school%3Acourse%3A..%2Fescape")).toBeUndefined()
    expect(groupChatRouteId(undefined)).toBeUndefined()
  })
})

describe("group chat message payloads", () => {
  test("a malformed payload from another person is read as empty, never thrown", () => {
    for (const payload of [null, undefined, "text", 3, [], { attachments: null, pinnedMaterials: "x" }])
      expect(groupMessagePayload(payload)).toEqual({
        attachments: [],
        pinnedMaterials: [],
        studioArtifact: undefined,
        mentions: { userIds: [], all: false },
      })
  })
  test("good items are kept and bad ones skipped one by one", () => {
    const payload = groupMessagePayload({
      attachments: [{ attachmentId: 1, filename: "notes.pdf" }, { attachmentId: "2" }, null],
      pinnedMaterials: [{ materialId: 4, title: "Week 1", downloadable: false }, { title: "no id" }],
      studioArtifact: { id: 7 },
      mentions: { userIds: [5, "6", 1.5], all: true },
    })
    expect(payload.attachments).toEqual([{ attachmentId: 1, filename: "notes.pdf" }])
    expect(payload.pinnedMaterials).toEqual([{ materialId: 4, title: "Week 1", downloadable: false }])
    expect(payload.studioArtifact).toBeUndefined()
    expect(payload.mentions).toEqual({ userIds: [5], all: true })
  })
})

describe("group chat refusals", () => {
  test("known refusal codes get their own wording; unknown ones keep the request's generic wording", () => {
    expect(groupChatRefusalKey({ status: "refused", code: "chat_moved_on" }, "send")).toBe("groupChat.refusal.movedOn")
    expect(groupChatRefusalKey({ status: "refused", code: "not_allowed" }, "send")).toBe("groupChat.refusal.notAllowed")
    expect(groupChatRefusalKey({ status: "refused", code: "not_allowed" }, "action")).toBe(
      "groupChat.refusal.notAllowedAction",
    )
    expect(groupChatRefusalKey({ status: "refused", code: "conversation_submitted" }, "send")).toBe("groupChat.locked")
    expect(groupChatRefusalKey({ status: "refused", code: "assistant_not_mentionable" }, "send")).toBe(
      "groupChat.refusal.notMentionable",
    )
    expect(groupChatRefusalKey({ status: "refused", code: "agent_busy" }, "send")).toBe("groupChat.busy")
    expect(groupChatRefusalKey({ status: "refused", code: "sso_required", httpStatus: 403 }, "open")).toBe(
      "groupChat.refusal.sso",
    )
    expect(groupChatRefusalKey({ status: "refused", code: "something_new" }, "send")).toBe("groupChat.sendFailed")
    expect(groupChatRefusalKey({ status: "refused", code: "something_new" }, "action")).toBe("groupChat.actionFailed")
    expect(groupChatRefusalKey({ status: "unreachable" }, "send")).toBe("groupChat.sendFailed")
    expect(groupChatRefusalKey({ status: "signed-out" }, "action")).toBe("groupChat.signedOut")
  })
  test("the server's own sentence stands in only where the app has no wording of its own", () => {
    expect(groupChatRefusal({ status: "refused", code: "course_archived", message: "Archived." }, "send")).toEqual({
      key: "groupChat.sendFailed",
      message: "Archived.",
    })
    expect(groupChatRefusal({ status: "refused", code: "chat_moved_on", message: "Moved on." }, "send")).toEqual({
      key: "groupChat.refusal.movedOn",
    })
    expect(groupChatRefusal({ status: "unreachable", message: "Bad gateway" }, "action")).toEqual({
      key: "groupChat.actionFailed",
    })
  })
  test("a code-less 400 points at the files only when the message carried some", () => {
    const refused = { status: "refused", httpStatus: 400 }
    expect(groupChatRefusalKey(refused, "send", true)).toBe("groupChat.refusal.attachment")
    expect(groupChatRefusalKey(refused, "send", false)).toBe("groupChat.sendFailed")
  })
  test("only a refusal that may mean changed access or rules asks for a fresh read", () => {
    expect(groupChatRefusalNeedsRead({ status: "refused", code: "not_allowed", httpStatus: 403 })).toBe(true)
    expect(groupChatRefusalNeedsRead({ status: "refused", httpStatus: 404 })).toBe(true)
    expect(groupChatRefusalNeedsRead({ status: "refused", code: "conversation_submitted", httpStatus: 409 })).toBe(true)
    expect(groupChatRefusalNeedsRead({ status: "refused", code: "agent_busy", httpStatus: 409 })).toBe(false)
    expect(groupChatRefusalNeedsRead({ status: "signed-out", httpStatus: 401 })).toBe(false)
  })
})

describe("group chat notices", () => {
  const mention = { server: "a", chatId: "school:course:chat-1" }
  test("an @mention is silent on that chat, a toast elsewhere in the focused app, and a system notice otherwise", () => {
    expect(groupChatMentionNotice(true, mention, mention)).toBe("none")
    expect(groupChatMentionNotice(true, { ...mention, chatId: "school:course:chat-2" }, mention)).toBe("toast")
    expect(groupChatMentionNotice(true, { ...mention, server: "b" }, mention)).toBe("toast")
    expect(groupChatMentionNotice(true, undefined, mention)).toBe("toast")
    expect(groupChatMentionNotice(false, mention, mention)).toBe("system")
  })
  test("lost access is told once even when the page and the app both hear it", () => {
    const seen = new Map<string, number>()
    expect(firstGroupChatLossNotice(seen, "chat", 0)).toBe(true)
    expect(firstGroupChatLossNotice(seen, "chat", 500)).toBe(false)
    expect(firstGroupChatLossNotice(seen, "other", 500)).toBe(true)
    expect(firstGroupChatLossNotice(seen, "chat", 20_000)).toBe(true)
  })
  test("the running answer belongs to this screen's own question first, else the latest agent turn", () => {
    const turns = [
      { turnId: 1, mode: "agent", assistantId: 3, askerId: 10, triggerSeq: 1 },
      { turnId: 2, mode: "human", assistantId: null, askerId: 11, triggerSeq: null },
    ]
    expect(runningGroupTurn(turns)).toMatchObject({ assistantId: 3, askerId: 10 })
    expect(runningGroupTurn(turns, { assistantId: 4, askerId: 12 })).toEqual({ assistantId: 4, askerId: 12 })
    expect(runningGroupTurn([turns[1]!])).toBeUndefined()
    expect(runningGroupTurn(undefined)).toBeUndefined()
  })
})

describe("group chat voice sessions", () => {
  const sequence = () => {
    let next = 0
    return () => `voice-${++next}`
  }
  test("every activity claims a fresh session id, so a released one is never used again", async () => {
    const released: string[] = []
    const release = async (id: string) => void released.push(id)
    const sessions = createVoiceSessions(sequence(), 10)
    const first = sessions.claim(() => {}, release)
    sessions.release(first, release)
    const second = sessions.claim(() => {}, release)
    expect(second).not.toBe(first)
    sessions.release(second, release)
    sessions.release(second, release)
    await sessions.settled()
    expect(released).toEqual([first, second])
  })
  test("starting an activity ends the one holding voice and releases its session", () => {
    const released: string[] = []
    const release = async (id: string) => void released.push(id)
    const sessions = createVoiceSessions(sequence(), 10)
    let stopped = 0
    const reading = sessions.claim(() => stopped++, release)
    const dictation = sessions.claim(() => {}, release)
    expect(stopped).toBe(1)
    expect(released).toEqual([reading])
    expect(sessions.holds(dictation)).toBe(true)
    // A late release of the ended activity leaves the current one holding voice.
    sessions.release(reading, release)
    expect(sessions.holds(dictation)).toBe(true)
    expect(released).toEqual([reading])
  })
  test("a release that never answers does not hold the next activity back for long", async () => {
    const sessions = createVoiceSessions(sequence(), 10)
    const hung = () => new Promise<void>(() => {})
    sessions.release(
      sessions.claim(() => {}, hung),
      hung,
    )
    const started = Date.now()
    await sessions.settled()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("group chat list rows", () => {
  const row = (id: string, courseId: string, title = id): Jolli.GroupChatSummary => ({
    id: Jolli.GroupChatID.make(`school:course:${id}`),
    title,
    courseId,
    courseCode: courseId,
    updatedAt: "2026-11-11T00:00:00Z",
    participantCount: 2,
    unreadCount: 0,
    processing: false,
    ownership: "member",
  })
  test("a complete read replaces the rows it covers and keeps other courses' rows", () => {
    const current = [row("a", "c1"), row("b", "c2")]
    expect(mergeGroupChatRows(current, [row("c", "c1")], undefined, true).map((item) => item.title)).toEqual(["c"])
    expect(mergeGroupChatRows(current, [row("c", "c1")], "c1", true).map((item) => item.title)).toEqual(["b", "c"])
  })
  test("an incomplete read only updates its own rows and never drops the rest", () => {
    const current = [row("a", "c1"), row("b", "c2")]
    expect(
      mergeGroupChatRows(current, [row("a", "c1", "renamed")], undefined, false).map((item) => item.title),
    ).toEqual(["b", "renamed"])
    expect(mergeGroupChatRows(current, [], "c1", false).map((item) => item.title)).toEqual(["a", "b"])
  })
})
