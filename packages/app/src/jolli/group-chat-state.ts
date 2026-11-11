import { createStore } from "solid-js/store"
import type { Jolli } from "@opencode-ai/schema/jolli"
import type { ServerConnection } from "@/context/server"
import type { GroupChatHolder, GroupChatOwners } from "./group-chat-owner"
const [state, setState] = createStore<{
  rows: Record<string, readonly Jolli.GroupChatSummary[]>
  enabled: Record<string, readonly string[]>
  drops: Record<string, number>
}>({ rows: {}, enabled: {}, drops: {} })
export const groupChatRows = (server: string) => state.rows[server] ?? []
export const groupChatCourses = (server: string) => state.enabled[server] ?? []
export function setGroupChatRows(
  server: string,
  rows: readonly Jolli.GroupChatSummary[],
  courseId?: string,
  complete = true,
) {
  setState("rows", server, mergeGroupChatRows(state.rows[server] ?? [], rows, courseId, complete))
}

/**
 * The rows after a list read. A complete read replaces the rows it covers (one course's, or all);
 * an incomplete one proves nothing about rows it left out, so those stay and only its own rows update.
 */
export function mergeGroupChatRows(
  current: readonly Jolli.GroupChatSummary[],
  rows: readonly Jolli.GroupChatSummary[],
  courseId: string | undefined,
  complete: boolean,
) {
  const fresh = new Set(rows.map((row) => row.id))
  const kept = current.filter(
    (row) => !fresh.has(row.id) && ((courseId !== undefined && row.courseId !== courseId) || !complete),
  )
  return [...kept, ...rows]
}
export function setGroupChatCourses(server: string, courses: readonly string[]) {
  setState("enabled", server, [...courses])
}
export function removeGroupChatRow(server: string, id: string) {
  setState("rows", server, (rows) => (rows ?? []).filter((row) => row.id !== id))
}
export function resetGroupChatRows(server: string) {
  setState("rows", server, [])
  setState("enabled", server, [])
}

const generations = new Map<string, number>()

/** Counts the times a server's chats were dropped as someone else's or nobody's, for views that must close then. */
export const groupChatDrops = (server: string) => state.drops[server] ?? 0

/**
 * Which sign-in a server's group chat answers belong to, as a count of resets. Read before a request
 * goes out and compared when its answer arrives: an answer that left before a reset may carry the
 * previous account's chats, and is dropped rather than written over the next account's.
 */
export function groupChatGeneration(server: string) {
  return generations.get(server) ?? 0
}

/**
 * What a list read does to the rows. A complete list replaces the rows it covers and a partial one
 * updates only its own. A lost sign-in is a plain reset, which {@link takeGroupChatList} applies before
 * this. `generation` is {@link groupChatGeneration} as the read went out; a read from before a reset is dropped.
 */
export function applyGroupChatList(
  server: string,
  answer: Jolli.GroupChatAnswer,
  generation: number,
  courseId?: string,
) {
  if (generation !== groupChatGeneration(server)) return
  if (answer.status === "unsupported") {
    resetGroupChatRows(server)
    return
  }
  if (answer.status !== "ok") return
  setGroupChatRows(server, answer.chats ?? [], courseId, answer.complete !== false)
  // A partial list may leave out tenants it could not ask, so their courses stay as they were.
  setGroupChatCourses(server, [
    ...new Set([...(answer.complete === false ? groupChatCourses(server) : []), ...(answer.enabledCourseIds ?? [])]),
  ])
}

/**
 * What a reset does to the rows. A plain reset means another account or none, so nothing of the old
 * account's chats may stay. The same account signing in again keeps them, and their tabs and drafts.
 * Answers whether the chats were dropped. Either way every answer still on its way is from before it,
 * and is dropped when it arrives.
 */
export function applyGroupChatReset(server: string, reset: { sameAccount?: boolean }) {
  generations.set(server, groupChatGeneration(server) + 1)
  if (reset.sameAccount === true) return false
  resetGroupChatRows(server)
  setState("drops", server, groupChatDrops(server) + 1)
  return true
}

/** What one window holds of a server's group chats besides the rows: its tabs, and whose they are. */
export type GroupChatWindow = {
  /** Closes every group chat tab of the server, open or closed, with the drafts and files kept for it. */
  removeGroupChats(server: ServerConnection.Key): void
  groupChatOwners: GroupChatOwners
}

/**
 * What a reset does in one window. A plain one (another person, nobody, a credential that went away, or
 * one this process could not tell) leaves nothing of the chats held: rows, tabs open or closed with their
 * drafts and files, open pages and dialogs (they close on {@link groupChatDrops}), and the record of whose
 * they were, so the next list's owner is taken as it comes. The same person signing in again over a
 * credential that was still valid keeps everything.
 */
export function resetGroupChatWindow(
  tabs: GroupChatWindow,
  server: ServerConnection.Key,
  reset: { sameAccount?: boolean } = {},
) {
  if (!applyGroupChatReset(server, reset)) return
  tabs.removeGroupChats(server)
  tabs.groupChatOwners.forget(server)
}

/**
 * What one window does with a list answer. No credential is a plain reset: the sidecar's own may have been
 * missed while the event stream was down. A list naming another owner than the one whose chats the window
 * holds (`held`, read as the answer arrived) is one too, missed the same way, and that owner is then
 * recorded as the one whose chats the window holds; so are chats the window kept from an earlier run without
 * recording whose they are. A window holding none it kept, as after a reset, takes the first owner without a drop.
 */
export function takeGroupChatList(
  tabs: GroupChatWindow,
  server: ServerConnection.Key,
  answer: Jolli.GroupChatAnswer,
  held: GroupChatHolder,
  courseId?: string,
) {
  if (answer.status === "signed-out") {
    resetGroupChatWindow(tabs, server)
    return
  }
  if (answer.status === "ok" && answer.owner) {
    if (held !== undefined && held !== answer.owner) resetGroupChatWindow(tabs, server)
    tabs.groupChatOwners.take(server, answer.owner)
  }
  applyGroupChatList(server, answer, groupChatGeneration(server), courseId)
}

/**
 * What one window does with a chat's open answer that names its owner: another owner than the one the window
 * recorded for the chats it holds is a plain reset, missed like a list's, and the page that read it closes with
 * its tab. Only lists record an owner, so a window with none recorded, or holding chats it kept without one,
 * leaves them to the next list: a page opened before the first list cannot drop itself. Answers whether it reset.
 */
export function takeGroupChatOwner(
  tabs: GroupChatWindow,
  server: ServerConnection.Key,
  owner: string | undefined,
  held: GroupChatHolder,
) {
  if (owner === undefined || typeof held !== "string" || held === owner) return false
  resetGroupChatWindow(tabs, server)
  return true
}

export function markGroupChatRead(server: string, id: string) {
  setState("rows", server, (rows) => (rows ?? []).map((row) => (row.id === id ? { ...row, unreadCount: 0 } : row)))
}
