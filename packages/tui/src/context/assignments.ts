/**
 * A STUDENT'S ASSIGNMENTS AS THE TERMINAL READS THEM: THROUGH THE SIDECAR, WHICH HAS ALREADY CHOSEN
 * THE ONES TO DO AND FOUND EACH TASK'S SESSION ON THIS MACHINE.
 *
 * ⚠ THE SAME ROUTES THE DESKTOP READS — `/jolli/assignment` and `/jolli/assignment/:courseId/:id` —
 * so the two surfaces cannot disagree about what is due or which session a task continues.
 */

import { participationSubmitted, participationWorkBlocked } from "@opencode-ai/core/jolli/assignment-actions"
import { HAND_IN_PERMISSIONS, handedInBy, taskBindingOf, taskLabel, toRead } from "@opencode-ai/core/jolli/assignment"
import { assignmentSettledSession, createAssignmentRefresh } from "@opencode-ai/core/jolli/assignment-watch"
import { useRenderer } from "@opentui/solid"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

/** Share concurrent reads across headers and dialogs, while preserving fresh settlement reads. */
type PendingRead = ReturnType<typeof createAssignmentRefresh<ReturnType<typeof toRead>>>
const pending = new WeakMap<ReturnType<typeof useSDK>["client"], Map<string, PendingRead>>()
const subscribers = new WeakMap<
  ReturnType<typeof useSDK>["client"],
  Map<string, Set<(read: ReturnType<typeof toRead>) => void>>
>()

export function refreshAssignment(
  client: ReturnType<typeof useSDK>["client"],
  courseId: string,
  assignmentId: string,
  fresh = true,
) {
  const reads = pending.get(client) ?? new Map<string, PendingRead>()
  pending.set(client, reads)
  const key = JSON.stringify([courseId, assignmentId])
  const reader =
    reads.get(key) ??
    createAssignmentRefresh(async (fresh) => {
      const response = await client.jolli
        .assignment({ courseId, assignmentId, ...(fresh ? { fresh: "true" as const } : {}) })
        .catch(() => undefined)
      return toRead(response?.data)
    })
  reads.set(key, reader)
  return reader
    .refresh(fresh)
    .then((answer) => {
      subscribers
        .get(client)
        ?.get(key)
        ?.forEach((accept) => accept(answer))
      return answer
    })
    .finally(() => {
      if (reads.get(key) === reader && !reader.loading()) reads.delete(key)
    })
}

/** An open assignment dialog follows completed work and shares fresh results with other TUI readers. */
export function useAssignmentRead(props: { courseId: string; assignmentId: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const event = useEvent()
  const target = createMemo(() => ({ courseId: props.courseId, assignmentId: props.assignmentId }), undefined, {
    equals: (a, b) => a?.courseId === b?.courseId && a?.assignmentId === b?.assignmentId,
  })
  const [read, control] = createResource(target, (key) => refreshAssignment(sdk.client, key.courseId, key.assignmentId))
  createEffect(() => {
    const key = JSON.stringify([target().courseId, target().assignmentId])
    const byAssignment =
      subscribers.get(sdk.client) ?? new Map<string, Set<(answer: ReturnType<typeof toRead>) => void>>()
    subscribers.set(sdk.client, byAssignment)
    const listeners = byAssignment.get(key) ?? new Set<(answer: ReturnType<typeof toRead>) => void>()
    byAssignment.set(key, listeners)
    listeners.add(control.mutate)
    onCleanup(() => {
      listeners.delete(control.mutate)
      if (!listeners.size) byAssignment.delete(key)
    })
  })
  onCleanup(
    event.subscribe((evt) => {
      if (evt.type === "message.part.updated") {
        const part = evt.properties.part
        if (part.type === "tool" && HAND_IN_PERMISSIONS.has(part.tool) && part.state.status === "completed") {
          void refreshAssignment(sdk.client, target().courseId, target().assignmentId)
        }
        return
      }
      const sessionID = assignmentSettledSession(evt)
      if (!sessionID) return
      const session = sync.data.session.find((item) => item.id === sessionID)
      if (
        taskBindingOf(session)?.assignmentId !== target().assignmentId ||
        courseBindingOf(session)?.courseId !== target().courseId
      )
        return
      void refreshAssignment(sdk.client, target().courseId, target().assignmentId)
    }),
  )
  return read
}

/** A task's completion and work permission, refreshed on settlement and while idle. */
export function useTaskHeader(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const sync = useSync()
  const event = useEvent()
  const renderer = useRenderer()
  const [generation, setGeneration] = createSignal({ count: 0, fresh: false })
  const refresh = (fresh = true) => setGeneration((value) => ({ count: value.count + 1, fresh }))
  onCleanup(
    event.subscribe((evt) => {
      if (evt.type === "message.part.updated") {
        const part = evt.properties.part
        if (part.type === "tool" && HAND_IN_PERMISSIONS.has(part.tool) && part.state.status === "completed") refresh()
        return
      }
      if (sessionID() && assignmentSettledSession(evt) === sessionID()) refresh()
    }),
  )

  const session = createMemo(() => {
    const id = sessionID()
    return id ? sync.data.session.find((item) => item.id === id) : undefined
  })
  const target = createMemo(
    () => {
      const found = session()
      const task = taskBindingOf(found)
      const course = courseBindingOf(found)
      if (!task || !course) return undefined
      return { courseId: course.courseId, task, sessionID: found!.id, generation: generation() }
    },
    undefined,
    {
      equals: (a, b) =>
        a?.courseId === b?.courseId &&
        a?.task.assignmentId === b?.task.assignmentId &&
        a?.task.partId === b?.task.partId &&
        a?.sessionID === b?.sessionID &&
        a?.generation.count === b?.generation.count,
    },
  )
  const [read] = createResource(target, async (key) => ({
    key,
    read: await refreshAssignment(sdk.client, key.courseId, key.task.assignmentId, key.generation.fresh),
  }))
  // Idle tasks need polling to discover teacher changes, including a switch into participation.
  // Only read this assignment; do not refresh the course-wide TODO list on a timer.
  const focus = { visible: true }
  const onFocus = () => {
    focus.visible = true
    if (target() && !read.loading) refresh(false)
  }
  const onBlur = () => {
    focus.visible = false
  }
  renderer.on("focus", onFocus)
  renderer.on("blur", onBlur)
  const poll = setInterval(() => {
    const id = sessionID()
    if (!focus.visible || !id || !target() || read.loading) return
    if (sync.data.session_status[id]?.type && sync.data.session_status[id].type !== "idle") return
    refresh(false)
  }, 30_000)
  onCleanup(() => {
    clearInterval(poll)
    renderer.off("focus", onFocus)
    renderer.off("blur", onBlur)
  })
  return () => {
    const answer = read.latest
    // A resource keeps its last answer when its source empties; it belongs to the session it was read for.
    if (!answer || answer.key.sessionID !== sessionID() || answer.read.status !== "ok") return undefined
    const found = answer.read.assignment.tasks.find((item) => item.partId === answer.key.task.partId)
    if (!found) return undefined
    return {
      label: taskLabel(answer.read.assignment.title, found.title),
      handedIn: handedInBy(answer.read.assignment, answer.key.task, answer.key.sessionID),
      submitted: participationSubmitted(found),
      workBlocked: participationWorkBlocked(answer.read.assignment, found),
    }
  }
}
