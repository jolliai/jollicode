import { createEffect, on, onCleanup } from "solid-js"
import { throttle } from "@solid-primitives/scheduled"
import { Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { tabKey, useTabs } from "@/context/tabs"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { groupChatHref, groupChatRouteId } from "@/utils/session-route"
import type { GROUP_CHAT_ENGLISH } from "@/i18n/group-chat-en"
import { HomeCourseSelection } from "./home-selection"
import { catalogGeneration } from "./catalog"
import {
  groupChatGeneration,
  groupChatDrops,
  groupChatRows,
  removeGroupChatRow,
  resetGroupChatWindow,
  takeGroupChatList,
  takeGroupChatOwner,
  type GroupChatWindow,
} from "./group-chat-state"
import { showToast } from "@/utils/toast"

export type GroupChatMessageKey = keyof typeof GROUP_CHAT_ENGLISH

export function decodeChatAnswer(value: unknown) {
  return Schema.decodeUnknownSync(Jolli.GroupChatAnswer)(value)
}

const PayloadAttachment = Schema.Struct({
  attachmentId: Schema.Int,
  filename: Schema.String,
  mimeType: Schema.String.pipe(Schema.optional),
})
const PayloadMaterial = Schema.Struct({
  materialId: Schema.Int,
  title: Schema.String,
  downloadable: Schema.Boolean.pipe(Schema.optional),
  unavailable: Schema.Boolean.pipe(Schema.optional),
})
const PayloadArtifact = Schema.Struct({ id: Schema.String })

function decodeEach<S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"][] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => Option.toArray(Schema.decodeUnknownOption(schema)(item)))
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

/** What a message's payload carries. The payload comes from other people: a malformed part is skipped, never thrown. */
export function groupMessagePayload(payload: unknown) {
  const data = record(payload)
  const mentions = record(data.mentions)
  return {
    attachments: decodeEach(PayloadAttachment, data.attachments),
    pinnedMaterials: decodeEach(PayloadMaterial, data.pinnedMaterials),
    studioArtifact: Option.getOrUndefined(Schema.decodeUnknownOption(PayloadArtifact)(data.studioArtifact)),
    mentions: {
      userIds: Array.isArray(mentions.userIds)
        ? mentions.userIds.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id))
        : [],
      all: mentions.all === true,
    },
  }
}

/**
 * The wording for a request the server refused. `send` is a message, `action` a change to the chat,
 * `open` reading it; `carried` says the refused message brought files or course materials, which the
 * server refuses without naming a code.
 *
 * A change with no answer that could be read ({@link groupChatOutcomeUnknown}) is told as a chat that
 * could not be reached, never as a change that was not saved: it may have been.
 */
export function groupChatRefusalKey(
  answer: { status: string; code?: string; httpStatus?: number },
  request: "send" | "action" | "open",
  carried = false,
): GroupChatMessageKey {
  const fallback =
    request === "send"
      ? "groupChat.sendFailed"
      : request === "open"
        ? "groupChat.unavailable"
        : "groupChat.actionFailed"
  if (answer.status === "signed-out") return "groupChat.signedOut"
  if (answer.status === "unsupported") return "groupChat.unsupported"
  if (answer.status === "unreachable" && request === "action") return "groupChat.unavailable"
  if (answer.status !== "refused") return fallback
  switch (answer.code) {
    case "agent_busy":
      return "groupChat.busy"
    case "assistant_not_mentionable":
      return "groupChat.refusal.notMentionable"
    case "chat_moved_on":
      return "groupChat.refusal.movedOn"
    case "not_allowed":
      return request === "send" ? "groupChat.refusal.notAllowed" : "groupChat.refusal.notAllowedAction"
    case "conversation_submitted":
      return "groupChat.locked"
    case "sso_required":
      return "groupChat.refusal.sso"
    case "student_shares_staff_only":
      return "groupChat.staffOnly"
    case "assignment_chat_membership":
      return "groupChat.attemptPeople"
    case "too_many_participants":
      return "groupChat.refusal.tooMany"
    case "not_in_course":
      return "groupChat.refusal.notInCourse"
    case "title_too_long":
      return "groupChat.refusal.titleTooLong"
    case "participants_required":
      return "groupChat.refusal.participantsRequired"
    case "attachment_send_closed":
      return "groupChat.refusal.attachment"
  }
  if (request === "send" && carried && answer.code === undefined && answer.httpStatus === 400)
    return "groupChat.refusal.attachment"
  return fallback
}

/** How a refusal is told: the app's own wording, or the server's sentence for a code the app has none for. */
export type GroupChatRefusal = { key: GroupChatMessageKey; message?: string }

export function groupChatRefusal(
  answer: { status: string; code?: string; httpStatus?: number; message?: string },
  request: "send" | "action" | "open",
  carried = false,
): GroupChatRefusal {
  const key = groupChatRefusalKey(answer, request, carried)
  const generic = key === "groupChat.sendFailed" || key === "groupChat.actionFailed" || key === "groupChat.unavailable"
  return generic && answer.status === "refused" && answer.message ? { key, message: answer.message } : { key }
}

/**
 * A change whose outcome is unknown: no answer arrived, or the server could not be reached or answered in
 * a way that could not be read. It may still have been made, so the chat is read back to show whether,
 * and nothing that rests on it having failed (a leave's mark, a "not saved" notice) is undone or told.
 */
export function groupChatOutcomeUnknown(answer: { status: string } | undefined) {
  return answer === undefined || answer.status === "unreachable"
}

/** A change the server turned down, so nothing was made: neither done, nor the chat gone, nor unknown. */
export function groupChatActionRefused(answer: { status: string } | undefined) {
  return !groupChatOutcomeUnknown(answer) && answer?.status !== "ok" && answer?.status !== "revoked"
}

/** What to tell about a change that did not go through as asked, or nothing when it did or the chat is gone. */
export function groupChatActionNotice(answer: Jolli.GroupChatAnswer | undefined): GroupChatRefusal | undefined {
  if (!answer) return { key: "groupChat.unavailable" }
  if (answer.status === "ok" || answer.status === "revoked") return undefined
  return groupChatRefusal(answer, "action")
}

/**
 * The refusal codes that turn the request away rather than answer for the chat or the change, and that a
 * later request may get past: an org the request could not be placed in for now (jolliedu answers
 * `tenant_resolution_failed` alike for every reason on purpose), a sign-in that does not match the
 * tenant yet, the account changing while the request was out, and the school asking for a fresh sign-in,
 * which the person may give in their browser without this app hearing of it.
 */
const PASSING_REFUSALS = new Set(["tenant_resolution_failed", "tenant_mismatch", "account_changed", "sso_required"])

/**
 * A refusal that says nothing lasting about what was asked: a timeout or a rate limit, or one of
 * {@link PASSING_REFUSALS}. Asked again later, the same request may be answered.
 */
export function groupChatRefusalPasses(answer: { status: string; code?: string; httpStatus?: number }) {
  return (
    answer.status === "refused" &&
    (answer.httpStatus === 408 ||
      answer.httpStatus === 429 ||
      (answer.code !== undefined && PASSING_REFUSALS.has(answer.code)))
  )
}

/**
 * Whether a read marker's answer settles it for its message: taken, or refused for good. A refusal that
 * turns the request away for now ({@link groupChatRefusalPasses}), a lost sign-in or no answer at all
 * leaves the marker to be sent again.
 */
export function groupChatMarkerSettled(answer: { status: string; code?: string; httpStatus?: number }) {
  return answer.status === "ok" || (answer.status === "refused" && !groupChatRefusalPasses(answer))
}

/**
 * A refusal that may mean the chat changed under the reader: lost access (the open read decides
 * whether it is gone or now read-only), a submitted chat, or an agent taken off the list.
 */
export function groupChatRefusalNeedsRead(answer: { status: string; code?: string; httpStatus?: number }) {
  return (
    answer.status === "refused" &&
    (answer.httpStatus === 403 ||
      answer.httpStatus === 404 ||
      answer.code === "conversation_submitted" ||
      answer.code === "assistant_not_mentionable")
  )
}

/** How to tell the reader about an @mention: not at all on that chat, in the app while it has focus, else by the system. */
export function groupChatMentionNotice(
  focused: boolean,
  open: { server: string; chatId: string } | undefined,
  mention: { server: string; chatId: string },
) {
  if (!focused) return "system" as const
  return open?.server === mention.server && open.chatId === mention.chatId ? ("none" as const) : ("toast" as const)
}

/** True the first time a chat's loss is reported within `window`, so the page and the app-wide listener say it once. */
export function firstGroupChatLossNotice(seen: Map<string, number>, key: string, now: number, window = 10_000) {
  for (const [entry, at] of seen) if (now - at > window) seen.delete(entry)
  if (seen.has(key)) return false
  seen.set(key, now)
  return true
}

/**
 * The turn an answer still being written belongs to: this screen's own ask until the read lists it,
 * else the chat's latest agent turn. People may write while an agent answers, so it is not
 * necessarily the last turn.
 */
export function runningGroupTurn(
  turns: readonly { mode: string; assistantId: number | null; askerId: number }[] | undefined,
  own?: { assistantId: number; askerId: number },
) {
  if (own) return own
  return (turns ?? []).findLast((turn) => turn.mode === "agent")
}

/** The asker or a staff participant may stop a running group answer. The server rechecks access. */
export function canStopGroupAnswer(chat: Jolli.GroupChat | undefined, own?: { assistantId: number; askerId: number }) {
  if (!chat?.processing || chat.access === "reader" || chat.viewerId === null) return false
  return (
    runningGroupTurn(chat.group.turns, own)?.askerId === chat.viewerId ||
    chat.group.participants.some((person) => person.userId === chat.viewerId && person.role === "staff")
  )
}

const lossNotices = new Map<string, number>()

/**
 * Marks the reader's own leave before its request goes out. The revocation that follows can reach the
 * app-wide listener before the leave's own answer does, and nobody should be told they lost a chat they
 * just left. Returns the undo, only for a leave the server turned down ({@link groupChatActionRefused}): a
 * leave whose answer was lost may have been taken, and the revocation that follows is then its own.
 */
export function beginGroupChatLeave(server: ServerConnection.Key, id: Jolli.GroupChatID) {
  const key = `${server}\n${id}`
  lossNotices.set(key, Date.now())
  return () => {
    lossNotices.delete(key)
  }
}

/** Takes a chat the reader can no longer open out of the sidebar and the tabs, and says so once. */
export function useGroupChatLoss() {
  const tabs = useTabs()
  const language = useLanguage()
  return (server: ServerConnection.Key, id: Jolli.GroupChatID, title?: string, quiet = false) => {
    const known =
      title ||
      groupChatRows(server).find((row) => row.id === id)?.title ||
      tabs.info[tabKey({ type: "groupChat", server, chatId: id })]?.title ||
      language.t("groupChat.title")
    removeGroupChatRow(server, id)
    tabs.removeGroupChats(server, [id])
    // Recorded even when quiet: leaving a chat is followed by its revocation on the stream, and the
    // app-wide listener must not then tell the person they lost a chat they just left.
    const first = firstGroupChatLossNotice(lossNotices, `${server}\n${id}`, Date.now())
    if (quiet || !first) return
    showToast({ title: language.t("groupChat.revoked", { title: known }) })
  }
}

/**
 * Closes the dialog that calls this when its server's group chats are dropped: the credential went away,
 * or another person signed in. A group chat dialog shows one account's chat, people or course, and acts as
 * that account: neither may carry over to the next person, and a dialog opened outside a chat page has no
 * page to close it.
 */
export function useCloseOnGroupChatReset() {
  const dialog = useDialog()
  const sdk = useServerSDK()
  // Every drop, whether a reset event said so, or a list or answer showed a reset that was missed.
  createEffect(
    on(
      () => groupChatDrops(ServerConnection.key(sdk().server)),
      () => dialog.close(),
      { defer: true },
    ),
  )
}

/**
 * What an answer about the person a read went out as does to everything this window holds of a server's group
 * chats: rows, tabs open or closed with their drafts and files, pages, dialogs and downloads. Every group chat
 * read in the window goes through it, so none keeps anything on its own once the person is gone or another.
 */
export function useGroupChatAccount() {
  const tabs = useTabs()
  return {
    /** The answer said the credential is gone. The sidecar's reset says so too, but may have been missed. */
    signOut: (server: ServerConnection.Key) => resetGroupChatWindow(tabs, server),
    /** An open answer naming another owner than the one this window recorded drops them. Answers whether it did. */
    otherOwner: async (server: ServerConnection.Key, answer: Jolli.GroupChatAnswer | undefined) =>
      answer?.owner !== undefined &&
      takeGroupChatOwner(tabs, server, answer.owner, await tabs.groupChatOwners.held(server)),
  }
}

/**
 * Applies `jolli.groupChat.reset` from each server's own event stream to this window, once per event and
 * server, and then calls `after` with the server it came from. Returns the stop.
 */
export function listenGroupChatResets(
  tabs: GroupChatWindow,
  servers: readonly { key: ServerConnection.Key; events: Pick<ServerSDK["event"], "listen"> }[],
  after: (server: ServerConnection.Key) => void,
) {
  const stops = servers.map((server) =>
    server.events.listen((event) => {
      const data = event.details
      if (data.type !== "jolli.groupChat.reset") return
      resetGroupChatWindow(tabs, server.key, data.properties)
      after(server.key)
    }),
  )
  return () => stops.forEach((stop) => stop())
}

/** Mounted once by the navigation model; updates also reach chats that are not open. */
export function useGroupChatConnection() {
  const global = useGlobal()
  const serverSDK = useServerSDK()
  const tabs = useTabs()
  const layout = useLayout()
  const platform = usePlatform()
  const language = useLanguage()
  const navigate = useNavigate()
  const lose = useGroupChatLoss()
  /** The selected server's list read, which a reset of that server asks for again once it is applied. */
  let current: { server: ServerConnection.Key; refresh: () => void } | undefined
  // Every server's resets, not only the selected one's: a page, a tab open or closed with its draft, or rows of
  // another server would otherwise outlive the credential they were read with.
  createEffect(
    on(global.servers.list, (list) =>
      onCleanup(
        listenGroupChatResets(
          tabs,
          list.map((conn) => ({ key: ServerConnection.key(conn), events: global.ensureServerCtx(conn).sdk.event })),
          (server) => {
            if (current?.server === server) current.refresh()
          },
        ),
      ),
    ),
  )
  createEffect(() => {
    const sdk = serverSDK()
    const server = ServerConnection.key(sdk.server)
    catalogGeneration()
    const courseId = HomeCourseSelection.courseId()
    let disposed = false
    let loading = false
    let again = false
    const refresh = (): void => {
      // A read starting now also covers every nudge that was waiting for one.
      nudge.clear()
      if (loading) {
        again = true
        return
      }
      loading = true
      // A list that left before a reset may be the previous account's; it is dropped when it arrives, and
      // the read the reset asked for runs after it. A change of server or course ends this effect instead.
      const generation = groupChatGeneration(server)
      void sdk.client.jolli
        .groupChats(courseId ? { courseId } : {})
        .then(async (response) => {
          const answer = decodeChatAnswer(response.data)
          // Read from this window's own record, which may still be loading.
          const held = await tabs.groupChatOwners.held(server)
          if (disposed || generation !== groupChatGeneration(server)) return
          takeGroupChatList(tabs, server, answer, held, courseId)
        })
        // Keep the last confirmed list through a transient disconnect.
        .catch(() => undefined)
        .finally(() => {
          loading = false
          if (!again || disposed) return
          again = false
          refresh()
        })
    }
    // Every message in any of the reader's chats nudges the list, and a read asks the server several
    // things: a burst of nudges is read once, shortly after the first. Made inside this effect, the
    // throttle registers its own `clear` with the effect's cleanup, so a nudge left waiting when the
    // course or server changes is dropped rather than read for the old one.
    const nudge = throttle(refresh, 300)
    current = { server, refresh }
    const stop = sdk.event.listen((event) => {
      const data = event.details
      // A chat's own `changed` reaches only that chat's page; the list moves on list and mention nudges.
      if (data.type === "jolli.groupChat.listChanged" || data.type === "jolli.groupChat.mention") nudge()
      if (data.type === "server.connected") refresh()
      if (data.type === "jolli.groupChat.revoked") {
        const id = groupChatRouteId(data.properties.chatID)
        if (id) lose(server, id)
      }
      if (data.type === "jolli.groupChat.mention") {
        const id = groupChatRouteId(data.properties.chatID)
        if (!id) return
        const route = layout.route()
        const notice = groupChatMentionNotice(
          document.hasFocus() && document.visibilityState !== "hidden",
          route.type === "groupChat" ? route : undefined,
          { server, chatId: id },
        )
        if (notice === "none") return
        const title = groupChatRows(server).find((row) => row.id === id)?.title || language.t("groupChat.title")
        const open = () => navigate(groupChatHref(server, id))
        if (notice === "toast") {
          showToast({
            title: language.t("groupChat.mentioned"),
            description: title,
            actions: [{ label: language.t("groupChat.openChat"), onClick: open }],
          })
          return
        }
        void platform.notify(language.t("groupChat.mentioned"), title, open)
      }
    })
    const focus = () => {
      if (document.visibilityState !== "hidden") refresh()
    }
    window.addEventListener("focus", focus)
    refresh()
    onCleanup(() => {
      disposed = true
      current = undefined
      stop()
      window.removeEventListener("focus", focus)
    })
  })
}
