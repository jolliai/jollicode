/**
 * "START A SESSION FOR THIS TASK", ASKED FROM THE ASSIGNMENT DIALOG, ANSWERED BY THE DRAFT IT OPENS.
 *
 * ⚠ `course-intent.ts`'S MECHANISM, FOR ITS REASONS. The dialog is opened from the sidebar, above the
 * `CourseSessionProvider` that owns the draft, and that provider is created by the very navigation the
 * click performs; the draft route nests two of them, and both must see the same task; and the request
 * is for one new session, retired by the first different route that claims it rather than inherited
 * by the next new session the student opens from anywhere. Read that file's notes for the history.
 *
 * ⚠ A SEPARATE SIGNAL, NOT A FIELD ON THE COURSE ONE. A course request picks a course and lets the
 * student choose an agent; a task fixes both, and the draft it makes cannot be re-chosen. Folding the
 * two together would let a course "+" click inherit a task's lock, or a task lose it.
 */

import type { TaskDraft } from "@opencode-ai/core/jolli/assignment"
import { createSignal } from "solid-js"

export type { TaskDraft }

const [pending, setPending] = createSignal<TaskDraft | undefined>(undefined)

let requestedAt: string | undefined
let claimedBy: string | undefined

export const AssignmentIntent = {
  pending,
  /** Ask for the next new session to be this task's. `from` is the route the student asked on. */
  request(task: TaskDraft, from: string) {
    setPending(task)
    requestedAt = from
    claimedBy = undefined
  },
  /** The requested task, if this route is the one the request was for — see `CourseIntent.claim`. */
  claim(routeKey: string) {
    const task = pending()
    if (!task) return undefined
    if (routeKey === requestedAt) return undefined
    if (claimedBy === undefined) {
      claimedBy = routeKey
      return task
    }
    if (routeKey === claimedBy) return task
    AssignmentIntent.clear()
    return undefined
  },
  clear() {
    setPending(undefined)
    requestedAt = undefined
    claimedBy = undefined
  },
}
