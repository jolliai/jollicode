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
    canOpen: !!task.local && !workable,
    readOnly: !workable,
  }
}

/** Participation is a task completion, never a claim that the current session was handed in. */
export function participationSubmitted(task: Jolli.AssignmentTask | undefined) {
  return (task?.requiresExplicitSubmit === false || task?.completionKind === "participation") && !!task.handedInAt
}

/** Preserve ordinary Code hand-in continuation; new read-only rules apply to participation practice. */
export function participationWorkBlocked(assignment: Jolli.Assignment, task: Jolli.AssignmentTask) {
  return (
    (task.requiresExplicitSubmit === false || task.completionKind === "participation") &&
    taskActionsOf(assignment, task).readOnly
  )
}
