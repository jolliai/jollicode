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
