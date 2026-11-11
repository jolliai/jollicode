import type { ReferenceAssignment } from "./reference-preview"
function isFileTask(task: { kind: string }) {
  return task.kind === "files"
}

/** Unknown identities from older servers are not evidence that a submitted snapshot changed. */
export function assignmentReferenceStatus(
  assignment: typeof ReferenceAssignment.Type,
  sourceId: string,
  taskId?: number,
): "current" | "changed" | "unknown" {
  const selected = assignment.parts.filter((task) => taskId === undefined || task.id === taskId)
  const tasks = selected.filter((task) => task.kind === "agent" || task.kind === "files")
  const hasUnknownTask = tasks.length !== selected.length
  const file = /^(?:hand-in-file|file):(\d+)$/.exec(sourceId)
  if (file !== null) {
    return tasks.some((task) => isFileTask(task) && task.submission?.files?.some((item) => item.id === Number(file[1])))
      ? "current"
      : hasUnknownTask
        ? "unknown"
        : "changed"
  }
  const doc = /^hand-in-doc:(\d+):(\d+)$/.exec(sourceId)
  const chat = /^hand-in-chat:(\d+)$/.exec(sourceId)
  if (doc === null && chat === null) {
    return "unknown"
  }
  const candidates = tasks.filter((task) => isFileTask(task) === (doc !== null))
  const submissionId = Number((doc ?? chat)?.[1])
  if (
    candidates.some(
      (task) =>
        task.submission?.submissionId === submissionId &&
        (doc === null || (isFileTask(task) && task.submission?.docs?.some((item) => item.position === Number(doc[2])))),
    )
  ) {
    return "current"
  }
  return hasUnknownTask ||
    candidates.some((task) => task.submission != null && task.submission.submissionId === undefined)
    ? "unknown"
    : "changed"
}
