/**
 * A STUDENT'S ASSIGNMENTS AS THE TERMINAL READS THEM: THROUGH THE SIDECAR, WHICH HAS ALREADY CHOSEN
 * THE ONES TO DO AND FOUND EACH TASK'S SESSION ON THIS MACHINE.
 *
 * ⚠ THE SAME ROUTES THE DESKTOP READS — `/jolli/assignment` and `/jolli/assignment/:courseId/:id` —
 * so the two surfaces cannot disagree about what is due or which session a task continues.
 */

import { HAND_IN_PERMISSIONS, handedInBy, taskBindingOf, taskLabel, toRead } from "@opencode-ai/core/jolli/assignment"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import { createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useSync } from "./sync"

/**
 * WHAT A TASK SESSION'S HEADER SAYS: WHICH TASK, AND WHETHER THIS IS THE SESSION HANDED IN FOR IT.
 *
 * ⚠ READ AGAIN WHEN A HAND-IN OR A TURN-IN COMPLETES, in this session or another the server runs. The
 * tool has already brought the sidecar's copy up to date, so the read needs no `fresh`. A teacher who
 * reopens the task takes the label away within the sidecar's minute-long cache.
 */
export function useTaskHeader(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const sync = useSync()
  const event = useEvent()
  const [handIns, setHandIns] = createSignal(0)
  onCleanup(
    event.on("message.part.updated", (evt) => {
      const part = evt.properties.part
      if (part.type !== "tool" || !HAND_IN_PERMISSIONS.has(part.tool) || part.state.status !== "completed") return
      setHandIns((count) => count + 1)
    }),
  )
  const session = createMemo(() => {
    const id = sessionID()
    return id ? sync.data.session.find((item) => item.id === id) : undefined
  })
  const [read] = createResource(
    () => {
      const found = session()
      const task = taskBindingOf(found)
      const course = courseBindingOf(found)
      if (!task || !course) return undefined
      return { courseId: course.courseId, task, sessionID: found!.id, handIns: handIns() }
    },
    async (key) => ({
      key,
      read: toRead(
        (
          await sdk.client.jolli
            .assignment({ courseId: key.courseId, assignmentId: key.task.assignmentId })
            .catch(() => undefined)
        )?.data,
      ),
    }),
  )
  return () => {
    const answer = read.latest
    // A resource keeps its last answer when its source empties; it belongs to the session it was read for.
    if (!answer || answer.key.sessionID !== sessionID() || answer.read.status !== "ok") return undefined
    const found = answer.read.assignment.tasks.find((item) => item.partId === answer.key.task.partId)
    if (!found) return undefined
    return {
      label: taskLabel(answer.read.assignment.title, found.title),
      handedIn: handedInBy(answer.read.assignment, answer.key.task, answer.key.sessionID),
    }
  }
}
