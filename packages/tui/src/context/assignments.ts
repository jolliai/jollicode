/**
 * A STUDENT'S ASSIGNMENTS AS THE TERMINAL READS THEM: THROUGH THE SIDECAR, WHICH HAS ALREADY CHOSEN
 * THE ONES TO DO AND FOUND EACH TASK'S SESSION ON THIS MACHINE.
 *
 * ⚠ THE SAME ROUTES THE DESKTOP READS — `/jolli/assignment` and `/jolli/assignment/:courseId/:id` —
 * so the two surfaces cannot disagree about what is due or which session a task continues.
 */

import { participationSubmitted, participationWorkBlocked } from "@opencode-ai/core/jolli/assignment-actions"
import { HAND_IN_PERMISSIONS, handedInBy, taskBindingOf, taskLabel, toRead } from "@opencode-ai/core/jolli/assignment"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import { createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

/** Share concurrent reads and run one trailing read when settlement overtakes an older request. */
type PendingRead = { again: boolean; promise: Promise<ReturnType<typeof toRead>> }
const pending = new WeakMap<ReturnType<typeof useSDK>["client"], Map<string, PendingRead>>()

function readAssignment(client: ReturnType<typeof useSDK>["client"], courseId: string, assignmentId: string) {
  const reads = pending.get(client) ?? new Map<string, PendingRead>()
  pending.set(client, reads)
  const key = JSON.stringify([courseId, assignmentId])
  const found = reads.get(key)
  if (found) {
    found.again = true
    return found.promise
  }
  const entry = {
    again: false,
    promise: Promise.resolve<ReturnType<typeof toRead>>({ status: "unreachable" }),
  }
  entry.promise = (async () => {
    try {
      for (;;) {
        entry.again = false
        const response = await client.jolli.assignment({ courseId, assignmentId, fresh: "true" }).catch(() => undefined)
        if (!entry.again) return toRead(response?.data)
      }
    } finally {
      reads.delete(key)
    }
  })()
  reads.set(key, entry)
  return entry.promise
}

/** A task's completion and work permission, refreshed on settlement and while idle. */
export function useTaskHeader(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const sync = useSync()
  const event = useEvent()
  const [generation, setGeneration] = createSignal(0)
  const refresh = () => setGeneration((count) => count + 1)
  onCleanup(
    event.subscribe((evt) => {
      if (evt.type === "message.part.updated") {
        const part = evt.properties.part
        if (part.type === "tool" && HAND_IN_PERMISSIONS.has(part.tool) && part.state.status === "completed") refresh()
        return
      }
      if (evt.type === "session.status") {
        if (evt.properties.sessionID === sessionID() && evt.properties.status.type === "idle") refresh()
        return
      }
      if (evt.type === "session.next.step.ended" && evt.properties.finish === "tool-calls") return
      // The local SDK uses session.next.*; newer sidecars may forward current execution events.
      if (
        ![
          "session.error",
          "session.next.step.ended",
          "session.next.step.failed",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
        ].includes(evt.type)
      )
        return
      const settled = evt as { properties?: { sessionID?: string }; data?: { sessionID?: string } }
      if ((settled.properties?.sessionID ?? settled.data?.sessionID) === sessionID()) refresh()
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
        a?.generation === b?.generation,
    },
  )
  const [read] = createResource(target, async (key) => ({
    key,
    read: await readAssignment(sdk.client, key.courseId, key.task.assignmentId),
  }))
  // A locked, idle composer cannot produce a local event after the teacher reopens its task.
  // Only read this assignment; do not refresh the course-wide TODO list on a timer.
  const poll = setInterval(() => {
    const answer = read.latest
    const id = sessionID()
    if (!id || !target() || read.loading) return
    if (answer?.key.sessionID === id && answer.read.status === "ok") {
      const task = answer.read.assignment.tasks.find((item) => item.partId === answer.key.task.partId)
      if (task?.requiresExplicitSubmit !== false && task?.completionKind !== "participation") return
    }
    if (sync.data.session_status[id]?.type && sync.data.session_status[id].type !== "idle") return
    refresh()
  }, 30_000)
  onCleanup(() => clearInterval(poll))
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
