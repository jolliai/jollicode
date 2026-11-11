import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerEvent } from "@/context/server-sdk"
import { migrateTabs } from "@/context/tab-migration"
import { pushClosedTab, takeClosedTab, removeClosedTabs, type ClosedTab } from "@/context/closed-tabs"
import type { GroupChatTab, SessionTab } from "@/context/tabs"
import { groupChatHref } from "@/utils/session-route"
import { ServerConnection } from "@/context/server"
import { sanitizeMarkdown } from "@opencode-ai/session-ui/markdown-sanitize"
import { voiceWav } from "./voice-wav"
import {
  firstGroupChatLossNotice,
  groupChatActionNotice,
  groupChatActionRefused,
  groupChatMarkerSettled,
  groupChatMentionNotice,
  groupChatOutcomeUnknown,
  groupChatRefusal,
  groupChatRefusalKey,
  groupChatRefusalNeedsRead,
  groupChatRefusalPasses,
  groupMessagePayload,
  listenGroupChatResets,
  runningGroupTurn,
  canStopGroupAnswer,
} from "./group-chat"
import { createVoiceSessions } from "./group-chat-voice"
import {
  applyGroupChatList,
  applyGroupChatReset,
  groupChatCourses,
  groupChatDrops,
  groupChatGeneration,
  groupChatRows,
  mergeGroupChatRows,
  resetGroupChatWindow,
  takeGroupChatList,
  takeGroupChatOwner,
} from "./group-chat-state"
import { unknownGroupChatOwner, type GroupChatOwners } from "./group-chat-owner"

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
  test("a link to a place in peer markdown points at its target's prefixed id, and trusted markdown is untouched", () => {
    const html =
      '<p><a href="#week-2">Week 2</a> <a href="#">Top</a></p><h2 id="week-2">Week 2</h2><a name="notes"></a>'
    const template = document.createElement("template")
    template.innerHTML = sanitizeMarkdown(html, true)
    const links = template.content.querySelectorAll("a[href]")
    expect(Array.from(links).map((link) => link.getAttribute("href"))).toEqual(["#user-content-week-2", "#"])
    expect(template.content.querySelector("h2")?.id).toBe("user-content-week-2")
    expect(template.content.querySelector("a[name]")?.getAttribute("name")).toBe("user-content-notes")
    template.innerHTML = sanitizeMarkdown(html)
    expect(template.content.querySelector("a[href]")?.getAttribute("href")).toBe("#week-2")
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
      key: "groupChat.unavailable",
    })
  })
  test("a change with no answer is told as a chat that could not be reached, never as a change not saved", () => {
    expect(groupChatRefusalKey({ status: "unreachable" }, "action")).toBe("groupChat.unavailable")
    expect(groupChatActionNotice(undefined)).toEqual({ key: "groupChat.unavailable" })
    expect(groupChatActionNotice({ status: "unreachable" })).toEqual({ key: "groupChat.unavailable" })
    expect(groupChatActionNotice({ status: "ok" })).toBeUndefined()
    expect(groupChatActionNotice({ status: "revoked", httpStatus: 404 })).toBeUndefined()
    expect(groupChatActionNotice({ status: "refused", code: "not_allowed", httpStatus: 403 })).toEqual({
      key: "groupChat.refusal.notAllowedAction",
    })
    expect(groupChatActionNotice({ status: "refused", code: "something_new", httpStatus: 409 })).toEqual({
      key: "groupChat.actionFailed",
    })
  })
  test("only a change the server turned down is undone; a lost answer or a gone chat is not", () => {
    expect(groupChatOutcomeUnknown(undefined)).toBe(true)
    expect(groupChatOutcomeUnknown({ status: "unreachable" })).toBe(true)
    expect(groupChatOutcomeUnknown({ status: "refused" })).toBe(false)
    expect(groupChatActionRefused(undefined)).toBe(false)
    expect(groupChatActionRefused({ status: "unreachable" })).toBe(false)
    expect(groupChatActionRefused({ status: "ok" })).toBe(false)
    expect(groupChatActionRefused({ status: "revoked" })).toBe(false)
    expect(groupChatActionRefused({ status: "refused" })).toBe(true)
    expect(groupChatActionRefused({ status: "signed-out" })).toBe(true)
  })
  test("a refusal that turns the request away for now passes; one about the chat or the request itself does not", () => {
    for (const passing of [
      { status: "refused", httpStatus: 408 },
      { status: "refused", code: "rate_limited", httpStatus: 429 },
      { status: "refused", code: "tenant_resolution_failed", httpStatus: 403 },
      { status: "refused", code: "tenant_mismatch", httpStatus: 403 },
      { status: "refused", code: "account_changed", httpStatus: 409 },
      { status: "refused", code: "sso_required", httpStatus: 403 },
    ])
      expect(groupChatRefusalPasses(passing)).toBe(true)
    for (const lasting of [
      { status: "refused", httpStatus: 403 },
      { status: "refused", httpStatus: 404 },
      { status: "refused", code: "not_allowed", httpStatus: 403 },
      { status: "refused", code: "conversation_submitted", httpStatus: 409 },
      { status: "unreachable" },
      { status: "signed-out", httpStatus: 401 },
    ])
      expect(groupChatRefusalPasses(lasting)).toBe(false)
  })
  test("a read marker is settled when taken or refused for good, and sent again otherwise", () => {
    expect(groupChatMarkerSettled({ status: "ok" })).toBe(true)
    expect(groupChatMarkerSettled({ status: "refused", httpStatus: 400 })).toBe(true)
    expect(groupChatMarkerSettled({ status: "refused", code: "not_allowed", httpStatus: 403 })).toBe(true)
    expect(groupChatMarkerSettled({ status: "refused", code: "tenant_resolution_failed", httpStatus: 403 })).toBe(false)
    expect(groupChatMarkerSettled({ status: "refused", code: "rate_limited", httpStatus: 429 })).toBe(false)
    expect(groupChatMarkerSettled({ status: "unreachable" })).toBe(false)
    expect(groupChatMarkerSettled({ status: "signed-out", httpStatus: 401 })).toBe(false)
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
  test("a list that never arrived keeps the rows; only a complete list replaces them", () => {
    const key = "rows-unreachable"
    const generation = groupChatGeneration(key)
    applyGroupChatList(key, { status: "ok", chats: [row("a", "c1")], enabledCourseIds: ["c1"] }, generation)
    applyGroupChatList(key, { status: "unreachable" }, generation)
    expect(groupChatRows(key).map((item) => item.title)).toEqual(["a"])
    expect(groupChatCourses(key)).toEqual(["c1"])
    applyGroupChatList(key, { status: "ok", chats: [row("b", "c2")], enabledCourseIds: ["c2"] }, generation)
    expect(groupChatRows(key).map((item) => item.title)).toEqual(["b"])
    expect(groupChatCourses(key)).toEqual(["c2"])
  })
  test("the same account signing in again keeps the rows; signing out or in as someone else drops them", () => {
    const key = "rows-reset"
    applyGroupChatList(
      key,
      { status: "ok", chats: [row("a", "c1")], enabledCourseIds: ["c1"] },
      groupChatGeneration(key),
    )
    expect(applyGroupChatReset(key, { sameAccount: true })).toBe(false)
    expect(groupChatRows(key).map((item) => item.title)).toEqual(["a"])
    expect(applyGroupChatReset(key, {})).toBe(true)
    expect(groupChatRows(key)).toEqual([])
    expect(groupChatCourses(key)).toEqual([])
  })
  test("a list that left before another account's sign-in never writes the previous account's rows back", () => {
    const key = "rows-late-other-account"
    const before = groupChatGeneration(key)
    applyGroupChatList(key, { status: "ok", chats: [row("a", "c1")], enabledCourseIds: ["c1"] }, before)
    expect(applyGroupChatReset(key, {})).toBe(true)
    // Both shapes of the previous account's list: a complete one would replace, a partial one would merge.
    applyGroupChatList(key, { status: "ok", chats: [row("a", "c1")], enabledCourseIds: ["c1"] }, before)
    applyGroupChatList(
      key,
      { status: "ok", complete: false, chats: [row("b", "c1")], enabledCourseIds: ["c1"] },
      before,
    )
    expect(groupChatRows(key)).toEqual([])
    expect(groupChatCourses(key)).toEqual([])
    // An unsupported answer from before the reset does not reach the next account's rows either.
    const after = groupChatGeneration(key)
    applyGroupChatList(key, { status: "ok", chats: [row("n", "c9")], enabledCourseIds: ["c9"] }, after)
    applyGroupChatList(key, { status: "unsupported" }, before)
    expect(groupChatRows(key).map((item) => item.title)).toEqual(["n"])
  })
  test("a list that left before the same account signed in again is dropped too; the next read decides", () => {
    const key = "rows-late-same-account"
    const before = groupChatGeneration(key)
    applyGroupChatList(key, { status: "ok", chats: [row("a", "c1")], enabledCourseIds: ["c1"] }, before)
    expect(applyGroupChatReset(key, { sameAccount: true })).toBe(false)
    applyGroupChatList(key, { status: "ok", chats: [], enabledCourseIds: [] }, before)
    expect(groupChatRows(key).map((item) => item.title)).toEqual(["a"])
    applyGroupChatList(
      key,
      { status: "ok", chats: [row("b", "c1")], enabledCourseIds: ["c1"] },
      groupChatGeneration(key),
    )
    expect(groupChatRows(key).map((item) => item.title)).toEqual(["b"])
  })
})

describe("what a window holds of a server's group chats", () => {
  const row = (id: string): Jolli.GroupChatSummary => ({
    id: Jolli.GroupChatID.make(`school:course:${id}`),
    title: id,
    courseId: "c1",
    courseCode: "c1",
    updatedAt: "2026-11-11T00:00:00Z",
    participantCount: 2,
    unreadCount: 0,
    processing: false,
    ownership: "member",
  })
  /**
   * A window holding `owner`'s chat `a` on its own server. Its tabs record what is closed, and whose chats it
   * holds is kept in memory here; how a window keeps that is tested with the browser tests.
   */
  async function holding(name: string, owner: string) {
    const key = ServerConnection.Key.make(`window-${name}`)
    const closed: string[] = []
    const owners = new Map<string, string>()
    const groupChatOwners: GroupChatOwners = {
      held: async (server) => owners.get(server),
      take: (server, value) => {
        owners.set(server, value)
      },
      forget: (server) => {
        owners.delete(server)
      },
    }
    const tabs = {
      removeGroupChats: (server: ServerConnection.Key) => {
        closed.push(server)
      },
      groupChatOwners,
    }
    takeGroupChatList(tabs, key, { status: "ok", owner, chats: [row("a")], enabledCourseIds: ["c1"] }, undefined)
    expect(await tabs.groupChatOwners.held(key)).toBe(owner)
    expect(closed).toEqual([])
    return { key, tabs, closed, drops: groupChatDrops(key) }
  }

  test("the same person signing in again over a valid credential keeps everything; a plain reset drops it all", async () => {
    const view = await holding("reset", "owner-a")
    const generation = groupChatGeneration(view.key)
    resetGroupChatWindow(view.tabs, view.key, { sameAccount: true })
    expect(groupChatGeneration(view.key)).toBe(generation + 1)
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["a"])
    expect(view.closed).toEqual([])
    expect(groupChatDrops(view.key)).toBe(view.drops)
    expect(await view.tabs.groupChatOwners.held(view.key)).toBe("owner-a")
    resetGroupChatWindow(view.tabs, view.key)
    expect(groupChatRows(view.key)).toEqual([])
    expect(groupChatCourses(view.key)).toEqual([])
    expect(view.closed).toEqual([view.key])
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    expect(await view.tabs.groupChatOwners.held(view.key)).toBeUndefined()
    // Nobody's chats are held any more: the next person's first list is taken without a second drop.
    takeGroupChatList(
      view.tabs,
      view.key,
      { status: "ok", owner: "owner-b", chats: [row("b")], enabledCourseIds: ["c1"] },
      await view.tabs.groupChatOwners.held(view.key),
    )
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["b"])
  })

  test("a list answering signed out drops what the window holds, as the reset it may have missed would", async () => {
    const view = await holding("signed-out", "owner-a")
    takeGroupChatList(
      view.tabs,
      view.key,
      { status: "signed-out", httpStatus: 401 },
      await view.tabs.groupChatOwners.held(view.key),
    )
    expect(groupChatRows(view.key)).toEqual([])
    expect(groupChatCourses(view.key)).toEqual([])
    expect(view.closed).toEqual([view.key])
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    expect(await view.tabs.groupChatOwners.held(view.key)).toBeUndefined()
  })

  test("a list of somebody else's chats drops the previous owner's first, then is taken as the new owner's", async () => {
    const view = await holding("owner", "owner-a")
    // The same owner, and a list that names none, change nothing.
    takeGroupChatList(
      view.tabs,
      view.key,
      { status: "ok", owner: "owner-a", chats: [row("a"), row("b")], enabledCourseIds: ["c1"] },
      "owner-a",
    )
    takeGroupChatList(view.tabs, view.key, { status: "unreachable" }, "owner-a")
    expect(view.closed).toEqual([])
    expect(groupChatDrops(view.key)).toBe(view.drops)
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["a", "b"])
    takeGroupChatList(
      view.tabs,
      view.key,
      { status: "ok", owner: "owner-b", complete: false, chats: [row("c")], enabledCourseIds: ["c2"] },
      "owner-a",
    )
    // Even a partial list keeps nothing of the previous owner's rows or courses.
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["c"])
    expect(groupChatCourses(view.key)).toEqual(["c2"])
    expect(view.closed).toEqual([view.key])
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    expect(await view.tabs.groupChatOwners.held(view.key)).toBe("owner-b")
  })

  test("chats kept from an earlier run with no recorded owner are dropped by the first list", async () => {
    const view = await holding("kept", "owner-a")
    // The window loaded tabs its record names no owner for: a build from before owners, or a run that stopped
    // between writing a tab and its owner.
    takeGroupChatList(
      view.tabs,
      view.key,
      { status: "ok", owner: "owner-b", chats: [row("b")], enabledCourseIds: ["c1"] },
      unknownGroupChatOwner,
    )
    expect(view.closed).toEqual([view.key])
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["b"])
    expect(await view.tabs.groupChatOwners.held(view.key)).toBe("owner-b")
  })

  test("after a reset forgot the owner, the first list's owner is taken without a drop", async () => {
    const view = await holding("forgotten", "owner-a")
    resetGroupChatWindow(view.tabs, view.key)
    const held = await view.tabs.groupChatOwners.held(view.key)
    expect(held).toBeUndefined()
    takeGroupChatList(
      view.tabs,
      view.key,
      { status: "ok", owner: "owner-b", chats: [row("b")], enabledCourseIds: ["c1"] },
      held,
    )
    expect(view.closed).toEqual([view.key])
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["b"])
    expect(await view.tabs.groupChatOwners.held(view.key)).toBe("owner-b")
  })

  test("a chat's open answer naming another owner than the recorded one drops what the window holds", async () => {
    const view = await holding("open-owner", "owner-a")
    // The same owner, an answer naming none, and a window with no record (a page opened before the first list,
    // or chats kept without one, which only a list settles) change nothing.
    expect(takeGroupChatOwner(view.tabs, view.key, "owner-a", "owner-a")).toBe(false)
    expect(takeGroupChatOwner(view.tabs, view.key, undefined, "owner-a")).toBe(false)
    expect(takeGroupChatOwner(view.tabs, view.key, "owner-b", undefined)).toBe(false)
    expect(takeGroupChatOwner(view.tabs, view.key, "owner-b", unknownGroupChatOwner)).toBe(false)
    expect(view.closed).toEqual([])
    expect(groupChatDrops(view.key)).toBe(view.drops)
    expect(groupChatRows(view.key).map((item) => item.title)).toEqual(["a"])
    expect(takeGroupChatOwner(view.tabs, view.key, "owner-b", "owner-a")).toBe(true)
    expect(groupChatRows(view.key)).toEqual([])
    expect(view.closed).toEqual([view.key])
    expect(groupChatDrops(view.key)).toBe(view.drops + 1)
    // The page never records an owner: the next list's is taken as it comes.
    expect(await view.tabs.groupChatOwners.held(view.key)).toBeUndefined()
  })

  test("a reset from a server that is not the selected one drops that server's chats, once", async () => {
    const selected = await holding("selected", "owner-a")
    const other = await holding("other", "owner-a")
    // One window: both servers' chats are closed through the same tabs.
    const closed: string[] = []
    const owners = new Map<string, string>([
      [selected.key, "owner-a"],
      [other.key, "owner-a"],
    ])
    const tabs = {
      removeGroupChats: (server: ServerConnection.Key) => {
        closed.push(server)
      },
      groupChatOwners: {
        held: async (server: string) => owners.get(server),
        take: (server: string, value: string) => {
          owners.set(server, value)
        },
        forget: (server: string) => {
          owners.delete(server)
        },
      } satisfies GroupChatOwners,
    }
    const streams = createRoot(() =>
      [selected.key, other.key].map((key) => ({ key, events: createGlobalEmitter<{ [key: string]: ServerEvent }>() })),
    )
    const after: string[] = []
    const stop = listenGroupChatResets(tabs, streams, (server) => after.push(server))
    const emit = (index: number, properties: { sameAccount?: boolean }) =>
      streams[index]?.events.emit("global", { id: "reset", type: "jolli.groupChat.reset", properties })
    const drops = { selected: groupChatDrops(selected.key), other: groupChatDrops(other.key) }

    emit(1, {})
    expect(closed).toEqual([other.key])
    expect(groupChatRows(other.key)).toEqual([])
    expect(groupChatDrops(other.key)).toBe(drops.other + 1)
    expect(owners.has(other.key)).toBe(false)
    // The selected server's chats stay, and only a reset of the selected server reads its list again.
    expect(groupChatRows(selected.key).map((item) => item.title)).toEqual(["a"])
    expect(groupChatDrops(selected.key)).toBe(drops.selected)
    expect(after).toEqual([other.key])

    // The same person signing in again over a valid credential keeps everything.
    emit(0, { sameAccount: true })
    expect(closed).toEqual([other.key])
    expect(groupChatRows(selected.key).map((item) => item.title)).toEqual(["a"])
    expect(after).toEqual([other.key, selected.key])

    stop()
    emit(0, {})
    expect(groupChatDrops(selected.key)).toBe(drops.selected)
    expect(after).toEqual([other.key, selected.key])
  })
})
