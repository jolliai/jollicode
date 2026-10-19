/**
 * THE STUDENT'S TODO ASSIGNMENTS, AS THE SIDEBAR LISTS THEM, AND ONE ASSIGNMENT AS ITS DIALOG AND A
 * TASK SESSION'S HEADER READ IT.
 *
 * ⚠ THE SIDECAR DOES THE WORK. `/jolli/assignment` has already picked the assignments to do, across
 * every course, and ordered them; `/jolli/assignment/:courseId/:assignmentId` has already found which
 * of a task's sessions is on this machine. This only holds the answers and says when to ask again.
 *
 * ⚠ A MODULE STORE, LIKE THE CATALOGUE'S. The sidebar is mounted at the router root, above every
 * provider, and the course bar inside a session; both read the same answers.
 *
 * ⚠ ASKED AGAIN WHEN A HAND-IN LANDS. The hand-in tools run in the sidecar, so the only thing this
 * renderer sees is the tool part completing; that is when the list's counts and a session's "Handed
 * in" label change, so that is when both are read again — past the sidecar's minute-long cache,
 * which the tool itself has already brought up to date.
 */

import type { Jolli } from "@opencode-ai/schema/jolli"
import { HAND_IN_PERMISSIONS, handedInBy, toRead, type TaskBinding } from "@opencode-ai/core/jolli/assignment"
import { createEffect, createResource, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { assignmentsGeneration, refreshAssignments, takeFresh } from "./assignment-refresh"

export { refreshAssignments }

const [todo, setTodo] = createStore<{
  status: "loading" | Jolli.CatalogStatus
  assignments: Jolli.AssignmentSummary[]
}>({ status: "loading", assignments: [] })

/**
 * THE TODO LIST, KEPT CURRENT FOR WHOEVER CALLS THIS.
 *
 * ⚠ AN ANSWER THAT FAILED KEEPS THE LIST IT HAD. A dropped connection is not "nothing to do", and
 * clearing the section under the student would say it is.
 */
export function useTodoAssignments() {
  const serverSDK = useServerSDK()
  createEffect(() => {
    const server = serverSDK()
    assignmentsGeneration()
    const asked = takeFresh()
    void server.client.jolli
      .assignments(asked ? { fresh: "true" } : undefined)
      .then((response) => {
        const data = response.data
        if (!data) return
        if (data.status === "unreachable" && todo.status === "ok") return
        setTodo({ status: data.status, assignments: [...data.assignments] })
      })
      .catch(() => undefined)
  })
  useHandInRefresh()
  return todo
}

/**
 * READ AGAIN WHEN A HAND-IN OR A TURN-IN COMPLETES, IN ANY SESSION THIS SERVER RUNS.
 *
 * ⚠ ONCE PER EVENT, HOWEVER MANY LISTEN — the same mark `useRefusalRefresh` leaves on an event.
 */
export function useHandInRefresh() {
  const serverSDK = useServerSDK()
  const stop = serverSDK().event.listen((e) => {
    const event = e.details
    if (event.type !== "message.part.updated") return
    const part = event.properties.part
    if (part.type !== "tool" || !HAND_IN_PERMISSIONS.has(part.tool) || part.state.status !== "completed") return
    if (answered.has(event)) return
    answered.add(event)
    refreshAssignments()
  })
  onCleanup(stop)
}

/** Events {@link useHandInRefresh} has already acted on. */
const answered = new WeakSet<object>()

/** One assignment as the sidecar answered it, or why it could not; `loading` until it has. */
export type AssignmentRead = { status: "loading" } | ReturnType<typeof toRead>

/** Read one assignment through the sidecar; `fresh` reaches past its minute-long cache. */
export async function readAssignment(
  client: ServerSDK["client"],
  courseId: string,
  assignmentId: string,
  fresh: boolean,
): Promise<AssignmentRead> {
  const response = await client.jolli
    .assignment({ courseId, assignmentId, ...(fresh ? { fresh: "true" as const } : {}) })
    .catch(() => undefined)
  return toRead(response?.data)
}

/** Turn an assignment in through the sidecar; the answer is the assignment as it then stands. */
export async function turnIn(
  client: ServerSDK["client"],
  courseId: string,
  assignmentId: string,
): Promise<AssignmentRead> {
  const response = await client.jolli.turnIn({ courseId, assignmentId }).catch(() => undefined)
  const read = toRead(response?.data)
  if (read.status === "ok") refreshAssignments()
  return read
}

/**
 * WHAT A TASK SESSION'S HEADER SAYS: WHICH TASK, AND WHETHER THIS IS THE SESSION HANDED IN FOR IT.
 *
 * ⚠ "HANDED IN" ONLY FOR THE SESSION THAT WAS. A task may have a session on another computer, or one
 * started again here; the label belongs to the one the teacher reads, which the gateway names.
 *
 * ⚠ READ ON EVERY HAND-IN, AND WHENEVER THE HEADER IS DRAWN AFRESH. A teacher who reopens the task
 * takes the label away within the sidecar's minute-long cache of the assignment.
 */
export function useTaskHeader(input: {
  courseId: () => string | undefined
  task: () => TaskBinding | undefined
  sessionID: () => string | undefined
}) {
  const serverSDK = useServerSDK()
  useHandInRefresh()
  const [read] = createResource(
    () => {
      const courseId = input.courseId()
      const task = input.task()
      if (!courseId || !task) return undefined
      return { courseId, assignmentId: task.assignmentId, generation: assignmentsGeneration() }
    },
    (key) => readAssignment(serverSDK().client, key.courseId, key.assignmentId, false),
  )
  return () => {
    const answer = read.latest
    const task = input.task()
    if (!task || answer?.status !== "ok") return undefined
    const found = answer.assignment.tasks.find((item) => item.partId === task.partId)
    if (!found) return undefined
    const sessionID = input.sessionID()
    return {
      label: `${answer.assignment.title} · ${found.title}`,
      handedIn: !!sessionID && handedInBy(answer.assignment, task, sessionID),
    }
  }
}
