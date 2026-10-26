import { createEffect, createRoot, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssignmentRead } from "@opencode-ai/core/jolli/assignment"

/** Refresh after turn settlement; streaming/tool parts are not completion evidence. */
export function assignmentSettledSession(event: { type: string; properties: unknown }) {
  const data = event.properties
  if (!data || typeof data !== "object" || !("sessionID" in data) || typeof data.sessionID !== "string")
    return undefined
  if (event.type === "session.status") {
    if (!("status" in data) || !data.status || typeof data.status !== "object") return undefined
    return "type" in data.status && data.status.type === "idle" ? data.sessionID : undefined
  }
  if (event.type === "session.next.step.ended" && "finish" in data && data.finish === "tool-calls") return undefined
  if (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted" ||
    event.type === "session.next.step.ended" ||
    event.type === "session.next.step.failed" ||
    event.type === "session.error"
  )
    return data.sessionID
  return undefined
}

type WatchInput = {
  client: object
  courseId: string
  assignmentId: string
  sessionID: string
  generation: Accessor<number>
  load: () => Promise<AssignmentRead>
  listen: (listener: (event: { type: string; properties: unknown }) => void) => () => void
  settled: (event: object) => void
}

/** One read, event subscription and lifecycle clock per client/assignment, shared by both headers. */
export function createAssignmentWatches() {
  const clients = new WeakMap<object, Map<string, ReturnType<typeof watch>>>()
  function watch(input: WatchInput, remove: () => void) {
    return createRoot((dispose) => {
      const [state, setState] = createStore<{ answer?: AssignmentRead }>({})
      const sessions = new Map<string, number>()
      const pending = { request: undefined as Promise<void> | undefined, again: false, disposed: false }
      const refresh = (): Promise<void> => {
        if (pending.request) {
          pending.again = true
          return pending.request
        }
        pending.request = (async () => {
          do {
            pending.again = false
            const answer = await input.load().catch(() => ({ status: "unreachable" as const }))
            if (pending.disposed) return
            if (answer.status !== "unreachable" || state.answer?.status !== "ok") setState("answer", answer)
          } while (pending.again)
        })().finally(() => {
          pending.request = undefined
          // A settlement can arrive after the loop's last check but before this promise settles.
          if (pending.again && !pending.disposed) return refresh()
          return undefined
        })
        return pending.request
      }
      createEffect(() => {
        input.generation()
        void refresh()
      })
      const stop = input.listen((event) => {
        const sessionID = assignmentSettledSession(event)
        if (sessionID && sessions.has(sessionID)) input.settled(event)
      })
      // An idle, read-only composer cannot emit a new turn when a teacher reopens its task.
      // Poll only its detail, and pause hidden windows; never poll the all-course TODO list.
      const visible = () => document.visibilityState !== "hidden"
      const focus = () => {
        if (visible()) void refresh()
      }
      const clock = setInterval(() => {
        if (visible()) void refresh()
      }, 30_000)
      window.addEventListener("focus", focus)
      document.addEventListener("visibilitychange", focus)
      onCleanup(() => {
        pending.disposed = true
        clearInterval(clock)
        window.removeEventListener("focus", focus)
        document.removeEventListener("visibilitychange", focus)
        stop()
      })
      return {
        answer: () => state.answer,
        retain(sessionID: string) {
          sessions.set(sessionID, (sessions.get(sessionID) ?? 0) + 1)
          return () => {
            const left = (sessions.get(sessionID) ?? 1) - 1
            if (left) sessions.set(sessionID, left)
            if (!left) sessions.delete(sessionID)
            if (sessions.size) return
            remove()
            dispose()
          }
        },
      }
    })
  }
  return {
    acquire(input: WatchInput) {
      const entries = clients.get(input.client) ?? new Map<string, ReturnType<typeof watch>>()
      clients.set(input.client, entries)
      const key = JSON.stringify([input.courseId, input.assignmentId])
      const entry = entries.get(key) ?? watch(input, () => entries.delete(key))
      entries.set(key, entry)
      onCleanup(entry.retain(input.sessionID))
      return entry.answer
    },
  }
}
