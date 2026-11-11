import { createStore } from "solid-js/store"
import type { Jolli } from "@opencode-ai/schema/jolli"
const [state, setState] = createStore<{
  rows: Record<string, readonly Jolli.GroupChatSummary[]>
  enabled: Record<string, readonly string[]>
}>({ rows: {}, enabled: {} })
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

export function markGroupChatRead(server: string, id: string) {
  setState("rows", server, (rows) => (rows ?? []).map((row) => (row.id === id ? { ...row, unreadCount: 0 } : row)))
}
