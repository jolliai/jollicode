import { createEffect, onCleanup } from "solid-js"
import { Option, Schema } from "effect"
import { Jolli } from "@opencode-ai/schema/jolli"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useNavigate } from "@solidjs/router"
import { groupChatHref } from "@/utils/session-route"
import type { GROUP_CHAT_ENGLISH } from "@/i18n/group-chat-en"
import { HomeCourseSelection } from "./home-selection"
import { catalogGeneration } from "./catalog"
import {
  groupChatCourses,
  groupChatRows,
  removeGroupChatRow,
  resetGroupChatRows,
  setGroupChatCourses,
  setGroupChatRows,
} from "./group-chat-state"
import { showToast } from "@/utils/toast"

export type GroupChatMessageKey = keyof typeof GROUP_CHAT_ENGLISH

export function decodeChatAnswer(value: unknown) {
  return Schema.decodeUnknownSync(Jolli.GroupChatAnswer)(value)
}

/**
 * The chat a route names, or nothing for an address that names none. A chat id holds only letters,
 * digits, `_`, `-` and the `:` separators, so `%3A` is the only escape a valid address carries.
 */
export function groupChatRouteId(raw: string | undefined) {
  if (!raw) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(Jolli.GroupChatID)(raw.replaceAll(/%3a/gi, ":")))
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
    if (quiet || !firstGroupChatLossNotice(lossNotices, `${server}\n${id}`, Date.now())) return
    showToast({ title: language.t("groupChat.revoked", { title: known }) })
  }
}

/** Mounted once by the navigation model; updates also reach chats that are not open. */
export function useGroupChatConnection() {
  const serverSDK = useServerSDK()
  const tabs = useTabs()
  const layout = useLayout()
  const platform = usePlatform()
  const language = useLanguage()
  const navigate = useNavigate()
  const lose = useGroupChatLoss()
  createEffect(() => {
    const sdk = serverSDK()
    const server = ServerConnection.key(sdk.server)
    catalogGeneration()
    const courseId = HomeCourseSelection.courseId()
    let disposed = false
    let loading = false
    let again = false
    const refresh = async () => {
      if (loading) {
        again = true
        return
      }
      loading = true
      try {
        const answer = decodeChatAnswer((await sdk.client.jolli.groupChats(courseId ? { courseId } : {})).data)
        if (disposed) return
        if (answer.status === "ok") {
          setGroupChatRows(server, answer.chats ?? [], courseId, answer.complete !== false)
          // A partial list may leave out tenants it could not ask, so their courses stay as they were.
          setGroupChatCourses(server, [
            ...new Set([
              ...(answer.complete === false ? groupChatCourses(server) : []),
              ...(answer.enabledCourseIds ?? []),
            ]),
          ])
        }
        if (answer.status === "signed-out" || answer.status === "unsupported") resetGroupChatRows(server)
      } catch {
        /* Keep the last confirmed list through a transient disconnect. */
      } finally {
        loading = false
        if (again && !disposed) {
          again = false
          void refresh()
        }
      }
    }
    const stop = sdk.event.listen((event) => {
      const data = event.details
      // A chat's own `changed` reaches only that chat's page; the list moves on list and mention nudges.
      if (
        data.type === "server.connected" ||
        data.type === "jolli.groupChat.listChanged" ||
        data.type === "jolli.groupChat.mention"
      )
        void refresh()
      if (data.type === "jolli.groupChat.reset") {
        resetGroupChatRows(server)
        tabs.removeGroupChats(server)
        void refresh()
      }
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
      if (document.visibilityState !== "hidden") void refresh()
    }
    window.addEventListener("focus", focus)
    void refresh()
    onCleanup(() => {
      disposed = true
      stop()
      window.removeEventListener("focus", focus)
    })
  })
}
