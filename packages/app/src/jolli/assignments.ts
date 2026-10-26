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
import { participationSubmitted, participationWorkBlocked } from "@opencode-ai/core/jolli/assignment-actions"
import {
  HAND_IN_PERMISSIONS,
  handedInBy,
  taskLabel,
  toRead,
  type TaskBinding,
} from "@opencode-ai/core/jolli/assignment"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import { assignmentsGeneration, refreshAssignments, takeFresh } from "./assignment-refresh"
import { createAssignmentWatches } from "./assignment-watch"

export { refreshAssignments }

const [todo, setTodo] = createStore<{
  status: "loading" | Jolli.CatalogStatus
  assignments: Jolli.AssignmentSummary[]
}>({ status: "loading", assignments: [] })

/** List requests across every caller: the newest asked, the newest shown, and the fresh ones still out. */
let listAsked = 0
let listShown = 0
let freshOut = 0

/**
 * THE TODO LIST, KEPT CURRENT FOR WHOEVER CALLS THIS.
 *
 * ⚠ AN ANSWER THAT FAILED KEEPS THE LIST IT HAD. A dropped connection is not "nothing to do", and
 * clearing the section under the student would say it is.
 *
 * ⚠ AN ANSWER OLDER THAN THE ONE SHOWN IS DROPPED. A cached read and the fresh one a hand-in asks for can
 * cross on the way back, and the older list landing last would put back the counts the hand-in changed.
 * One older than a request still out is kept, though: that request may never answer.
 *
 * ⚠ A REQUEST MADE WHILE A FRESH ONE IS OUT IS FRESH TOO. The sidecar keeps the list only once a fresh
 * read has finished, so a cached read made meanwhile may answer from before it; asked past the cache,
 * the later request is at least as new as the earlier, which is what ordering by request relies on.
 */
export function useTodoAssignments() {
  const serverSDK = useServerSDK()
  createEffect(() => {
    const server = serverSDK()
    assignmentsGeneration()
    const fresh = takeFresh() || freshOut > 0
    const request = ++listAsked
    if (fresh) freshOut++
    void server.client.jolli
      .assignments(fresh ? { fresh: "true" } : undefined)
      .then((response) => {
        const data = response.data
        if (!data || request < listShown) return
        if (data.status === "unreachable" && todo.status === "ok") return
        listShown = request
        setTodo({ status: data.status, assignments: [...data.assignments] })
      })
      .catch(() => undefined)
      .finally(() => {
        if (fresh) freshOut--
      })
  })
  useHandInRefresh()
  return todo
}

/** "Task 2": a task's place among its assignment's, in the student's language. */
export function useTaskTitle() {
  const language = useLanguage()
  return (index: number) => language.t("dialog.assignment.task.title", { number: index + 1 })
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
const assignmentWatches = createAssignmentWatches()

/** One assignment as the sidecar answered it, or why it could not; `loading` until it has. */
export type AssignmentRead = { status: "loading" } | ReturnType<typeof toRead>

/** Read one assignment through the sidecar; `fresh` reaches past its minute-long cache. */
export async function readAssignment(
  client: ServerSDK["client"],
  courseId: string,
  assignmentId: string,
  fresh: boolean,
): Promise<ReturnType<typeof toRead>> {
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
  const taskTitle = useTaskTitle()
  useHandInRefresh()
  const watched = createMemo(() => {
    const client = serverSDK().client
    const courseId = input.courseId()
    const task = input.task()
    const sessionID = input.sessionID()
    if (!courseId || !task || !sessionID) return undefined
    return assignmentWatches.acquire({
      client,
      courseId,
      assignmentId: task.assignmentId,
      sessionID,
      generation: assignmentsGeneration,
      load: () => readAssignment(client, courseId, task.assignmentId, true),
      listen: (listener) => serverSDK().event.listen((e) => listener(e.details)),
      settled: (event) => {
        if (answered.has(event)) return
        answered.add(event)
        refreshAssignments()
      },
    })
  })
  return () => {
    const answer = watched()?.()
    const task = input.task()
    if (!task || answer?.status !== "ok") return undefined
    const index = answer.assignment.tasks.findIndex((item) => item.partId === task.partId)
    if (index < 0) return undefined
    const sessionID = input.sessionID()
    return {
      label: taskLabel(answer.assignment.title, taskTitle(index)),
      handedIn: !!sessionID && handedInBy(answer.assignment, task, sessionID),
      submitted: participationSubmitted(answer.assignment.tasks[index]),
      workBlocked: participationWorkBlocked(answer.assignment, answer.assignment.tasks[index]),
    }
  }
}
