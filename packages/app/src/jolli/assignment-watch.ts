import { createEffect, createRoot, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssignmentRead } from "@opencode-ai/core/jolli/assignment"
import { assignmentSettledSession, createAssignmentRefresh } from "@opencode-ai/core/jolli/assignment-watch"

type WatchInput = {
  client: object
  courseId: string
  assignmentId: string
  sessionID: string
  generation: Accessor<number>
  load: (fresh: boolean) => Promise<AssignmentRead>
  listen: (listener: (event: { type: string; properties: unknown }) => void) => () => void
}

/** One read, event subscription and lifecycle clock per client/assignment, shared by both headers. */
export function createAssignmentWatches() {
  const clients = new WeakMap<object, Map<string, ReturnType<typeof watch>>>()
  function watch(input: WatchInput, remove: () => void) {
    return createRoot((dispose) => {
      const [state, setState] = createStore<{ answer?: AssignmentRead }>({})
      const sessions = new Map<string, number>()
      const refresh = createAssignmentRefresh(
        (fresh) => input.load(fresh).catch(() => ({ status: "unreachable" as const })),
        (answer) => {
          // Replaced whole: a path set would merge one answer's fields into the previous answer's.
          if (answer.status !== "unreachable" || state.answer?.status !== "ok") setState({ answer })
        },
      )
      createEffect(() => {
        input.generation()
        void refresh.refresh(true)
      })
      const stop = input.listen((event) => {
        const sessionID = assignmentSettledSession(event)
        if (sessionID && sessions.has(sessionID)) void refresh.refresh(true)
      })
      // An idle, read-only composer cannot emit a new turn when a teacher reopens its task.
      // Poll only its detail, and pause hidden windows; never poll the all-course TODO list.
      const visible = () => document.visibilityState !== "hidden"
      const focus = () => {
        if (visible()) void refresh.refresh()
      }
      const clock = setInterval(() => {
        if (visible()) void refresh.refresh()
      }, 30_000)
      window.addEventListener("focus", focus)
      document.addEventListener("visibilitychange", focus)
      onCleanup(() => {
        refresh.dispose()
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
