import type { Jolli } from "@opencode-ai/schema/jolli"

/** Task completion and permission to keep practicing are independent. Older servers use hand-in rules. */
export function taskActionsOf(assignment: Jolli.Assignment, task: Jolli.AssignmentTask) {
  const participation = task.requiresExplicitSubmit === false
  const blocked = task.workBlocked ?? (!!task.handedInAt && (!participation || assignment.turnedIn))
  const workable = task.place === "jolli_code" && task.owed && !blocked
  return {
    canStart: workable && !task.local && (participation || !task.handedInAt),
    canContinue: workable && !!task.local,
    canRestart: workable && participation && !!task.local,
    readOnly: !workable,
  }
}

/**
 * Participation is a task completion, never a claim that the current session was handed in. The receipt
 * decides: a hand-in made before the teacher switched the task to participation is still a hand-in.
 */
export function participationSubmitted(task: Jolli.AssignmentTask | undefined) {
  return task?.completionKind === "participation" && !!task.handedInAt
}

/** Preserve ordinary Code hand-in continuation; new read-only rules apply to participation practice. */
export function participationWorkBlocked(assignment: Jolli.Assignment, task: Jolli.AssignmentTask) {
  return isParticipation(task) && taskActionsOf(assignment, task).readOnly
}

/** Recognize participation from current delivery settings or a prior participation receipt. */
export function isParticipation(task: Jolli.AssignmentTask | undefined) {
  return task?.requiresExplicitSubmit === false || task?.completionKind === "participation"
}

/**
 * WHERE A TASK STANDS, ONCE FOR EVERY SURFACE: the terminal's `/assignment` and the desktop dialog each
 * word `kind` their own way.
 *
 * ⚠ `optional` ONLY FOR A TASK STILL OWED. One nobody owes any more reads "No longer needed" alone.
 */
export function taskStandingOf(task: Jolli.AssignmentTask) {
  const optional = isOptional(task)
  if (task.handedInAt) return { kind: participationSubmitted(task) ? "submitted" : "handed-in", optional } as const
  if (!task.owed) return { kind: "not-owed", optional } as const
  if (task.place === "web") return { kind: "web", optional } as const
  if (task.local) return { kind: "in-progress", optional } as const
  if (task.elsewhere) return { kind: "elsewhere", optional } as const
  return { kind: "not-started", optional } as const
}

export type TaskStandingKind = ReturnType<typeof taskStandingOf>["kind"]

/** An optional task counts only while the student still owes it. */
export function isOptional(task: Pick<Jolli.AssignmentTask, "owed" | "optional">) {
  return task.owed && task.optional === true
}

/** The gateway needs one receipt when every owed task is optional; a reading with no tasks needs none. */
export function needsFirstHandIn(assignment: Pick<Jolli.Assignment, "tasks">) {
  const owed = assignment.tasks.filter((task) => task.owed)
  return owed.length > 0 && owed.every((task) => isOptional(task) && !task.handedInAt)
}

/** A next step the student can actually take, omitted when none of the optional tasks can be worked. */
export function firstHandInAction(assignment: Jolli.Assignment) {
  if (assignment.turnedIn || !needsFirstHandIn(assignment)) return undefined
  const available = openOptionalTasks(assignment).filter((task) => !task.workBlocked)
  if (available.length === 0) return undefined
  return available.every(isParticipation) ? "participate" : "hand-in"
}

/** A task as a sentence names it: "Task 2 (Lab report)". */
export function taskMention(task: Pick<Jolli.AssignmentTask, "title" | "name">) {
  return `${task.title} (${task.name})`
}

/** The optional tasks still owed and not handed in: what turning the assignment in now leaves out. */
export function openOptionalTasks(assignment: Pick<Jolli.Assignment, "tasks">) {
  return assignment.tasks.filter((task) => isOptional(task) && !task.handedInAt)
}
