/**
 * A STUDENT'S ASSIGNMENTS IN JOLLI CODE: WHICH ARE TO DO, WHAT A TASK'S SESSION IS, AND WHAT A
 * HAND-IN ASKS THE STUDENT TO APPROVE.
 *
 * ⚠ ONE MODULE FOR EVERY SURFACE. The sidecar answers the desktop's TODO Assignments and the TUI's
 * `/assignment` from {@link todoAssignments} and {@link projectAssignment}, the hand-in tools build
 * their permission request with {@link handInLines}, and both renderers ask
 * {@link isNeverAutoApproved} before they answer a request for the student. Three copies of any of
 * these would drift on exactly the cases that matter: what counts as due, and what may be approved
 * without the student.
 *
 * ⚠ THE GATEWAY DECIDES, THIS ONLY LISTS. Whether a task may start, take a turn or be handed in is
 * checked on the gateway every time; a list here that is a minute old offers something the gateway
 * then refuses, in words it chooses.
 */
import type { Jolli } from "@opencode-ai/schema/jolli"
import type {
  HandInPreview,
  StudentAssignment,
  StudentAssignmentAgentPart,
  StudentAssignmentList,
  StudentAssignmentPart,
} from "./api"

// ── A task's session ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH TASK A SESSION WAS STARTED FOR, AS THE START ROUTE RECORDED IT.
 *
 * ⚠ ITS OWN KEY, BESIDE `jolli`, AND SERVER-OWNED LIKE `jolliOpener`. Only the start route writes it,
 * from a start the gateway accepted; no metadata write may set, change or drop it. A client that could
 * would offer the hand-in tools in a session the gateway never bound to the task.
 *
 * ⚠ ONLY UNDER THE SESSION IT WAS WRITTEN FOR. A fork copies the metadata it rides in, and a fork is a
 * plain session: the gateway bound the task to the original's id, not the copy's. Carrying the id is
 * what tells them apart without the fork having to know about tasks.
 */
export const TASK_KEY = "jolliTask"

export type TaskBinding = {
  readonly assignmentId: string
  readonly partId: string
  /** The commit the project's HEAD was at when the session started; absent outside a repository. */
  readonly startHead?: string
}

type SessionLike = { id: string; metadata?: Record<string, unknown> | undefined }

/** The task this session was started for, or undefined for any other session — a fork included. */
export function taskBindingOf(session: SessionLike | undefined): TaskBinding | undefined {
  const raw = session?.metadata?.[TASK_KEY]
  if (!session || !raw || typeof raw !== "object") return undefined
  const value = raw as { sessionID?: unknown; assignmentId?: unknown; partId?: unknown; startHead?: unknown }
  if (value.sessionID !== session.id) return undefined
  if (typeof value.assignmentId !== "string" || typeof value.partId !== "string") return undefined
  return {
    assignmentId: value.assignmentId,
    partId: value.partId,
    ...(typeof value.startHead === "string" ? { startHead: value.startHead } : {}),
  }
}

/**
 * A NEW SESSION TO BE STARTED FOR A TASK, AS BOTH RENDERERS STAGE IT: who it is with, which task, and
 * how the composer names it ("Lab 4: Linked lists · Task 2").
 */
export type TaskDraft = {
  readonly courseId: string
  readonly assistantId: string
  readonly assignmentId: string
  readonly partId: string
  readonly label: string
}

/**
 * The draft a task of this assignment starts from; undefined for a task with no agent, never started here.
 *
 * ⚠ `title` IS THE TASK'S AS THE RENDERER WORDS IT. The desktop translates "Task 2", and its composer
 * must name the task as the dialog and the session header beside it do.
 */
export function taskDraftOf(
  assignment: Jolli.Assignment,
  task: Jolli.AssignmentTask,
  title = task.title,
): TaskDraft | undefined {
  if (task.assistantId === null) return undefined
  return {
    courseId: assignment.courseId,
    assistantId: task.assistantId,
    assignmentId: assignment.id,
    partId: task.partId,
    label: taskLabel(assignment.title, title),
  }
}

/**
 * HOW A TASK IS NAMED BESIDE ITS COMPOSER: "Lab 4: Linked lists · Task 2". The draft's label and a
 * started session's header are both this, so the line does not change when the session starts.
 */
export function taskLabel(assignmentTitle: string, taskTitle: string) {
  return `${assignmentTitle} · ${taskTitle}`
}

/** The record the start route writes under {@link TASK_KEY}. */
export function taskRecord(sessionID: string, task: TaskBinding) {
  return { sessionID, ...task }
}

// ── The TODO list ────────────────────────────────────────────────────────────────────────────────

/** A course the student takes, as the list reads it. */
export type StudentCourse = { readonly id: string; readonly code: string }

/**
 * THE ASSIGNMENTS TO DO, ACROSS THE STUDENT'S COURSES, DUE SOONEST FIRST.
 *
 * ⚠ "TO DO" IS THE GATEWAY'S `todo` GROUP LESS WHAT CANNOT TAKE WORK: a closed one, and one past a due
 * date it stops at. Both would be refused at the first turn, so listing them would offer a Start the
 * student cannot use.
 *
 * ⚠ AND ONLY ONE WITH A JOLLI CODE TASK. An assignment worked wholly on the web has nothing to start
 * here; the web lists it.
 */
export function todoAssignments(
  lists: ReadonlyArray<{ course: StudentCourse; list: StudentAssignmentList }>,
  now: number,
): Jolli.AssignmentSummary[] {
  return lists
    .flatMap(({ course, list }) =>
      list.todo
        .filter((item) => item.status === "published")
        .filter((item) => !pastStop(item, now))
        .filter((item) => (item.tasks ?? []).some((task) => task.workedIn === "jolli_code"))
        .map((item) => ({
          id: String(item.id),
          courseId: course.id,
          courseCode: course.code,
          title: item.title,
          dueAt: item.dueAt,
          stopAtDue: item.stopAtDue,
          // Every kind's tasks, as the assignment's dialog counts them: `tasks` holds the agent ones alone.
          tasksHandedIn: item.progress.partsSubmitted,
          tasksTotal: item.progress.partsTotal,
        })),
    )
    .toSorted(byDue)
}

function pastStop(item: { dueAt: string | null; stopAtDue: boolean }, now: number) {
  if (!item.stopAtDue || item.dueAt === null) return false
  const due = Date.parse(item.dueAt)
  return Number.isFinite(due) && due <= now
}

/** Due soonest first; no due date last; then by title, so the order does not shuffle between reads. */
function byDue(left: Jolli.AssignmentSummary, right: Jolli.AssignmentSummary) {
  const a = left.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.dueAt)
  const b = right.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.dueAt)
  if (a !== b) return a < b ? -1 : 1
  return left.title.localeCompare(right.title)
}

// ── One assignment ───────────────────────────────────────────────────────────────────────────────

/** A session that is on this machine, as the projection needs it. */
export type LocalSession = { readonly directory: string; readonly updated: number }

/**
 * ONE ASSIGNMENT, AS THE ASSIGNMENT DIALOG READS IT.
 *
 * ⚠ `local` IS THE NEWEST OF THE TASK'S SESSIONS THAT IS HERE. The gateway lists every session a task
 * was started under, from every machine the student used; only one on this machine can be continued,
 * and continuing beats starting again because a task takes one session handed in.
 *
 * ⚠ THE HANDED-IN SESSION IS NAMED BY ID, so a session's header can say "Handed in" by comparing its
 * own id rather than asking anything else.
 */
export function projectAssignment(
  course: StudentCourse,
  assignment: StudentAssignment,
  locals: ReadonlyMap<string, LocalSession>,
  now: number,
): Jolli.Assignment {
  const tasks = assignment.parts.map((part, index): Jolli.AssignmentTask => {
    if (!isAgentPart(part)) {
      return {
        partId: String(part.id),
        title: `Task ${index + 1}`,
        name: part.name,
        assistantId: null,
        assistantBlurb: null,
        place: "web",
        handedInAt: part.submission?.submittedAt ?? null,
        handedInSessionID: null,
        owed: part.owed,
        local: null,
        elsewhere: false,
      }
    }
    const place = part.workedIn === "jolli_code" ? ("jolli_code" as const) : ("web" as const)
    const handedIn = part.submission
      ? part.attempts.find((attempt) => attempt.id === part.submission?.attemptId)
      : undefined
    const sessions = place === "jolli_code" ? part.attempts.map((attempt) => attempt.conversationId) : []
    const here = sessions
      .flatMap((sessionID) => {
        const found = locals.get(sessionID)
        return found ? [{ sessionID, ...found }] : []
      })
      .toSorted((a, b) => b.updated - a.updated)[0]
    return {
      partId: String(part.id),
      title: `Task ${index + 1}`,
      name: part.assistantName,
      assistantId: String(part.assistantId),
      assistantBlurb: part.assistantBlurb,
      place,
      handedInAt: part.submission?.submittedAt ?? null,
      handedInSessionID: place === "jolli_code" ? (handedIn?.conversationId ?? null) : null,
      owed: part.owed,
      local: here ? { sessionID: here.sessionID, directory: here.directory } : null,
      elsewhere: sessions.some((sessionID) => !locals.has(sessionID)),
    }
  })
  const owed = tasks.filter((task) => task.owed)
  const turnedIn = assignment.progress.turnedInAt !== null
  return {
    id: String(assignment.id),
    courseId: course.id,
    courseCode: course.code,
    title: assignment.title,
    description: assignment.description,
    dueAt: assignment.dueAt,
    stopAtDue: assignment.stopAtDue,
    authorName: assignment.authorName,
    tasksHandedIn: owed.filter((task) => task.handedInAt !== null).length,
    tasksTotal: owed.length,
    turnedIn,
    readyToTurnIn:
      !turnedIn &&
      assignment.status === "published" &&
      !pastStop(assignment, now) &&
      owed.every((task) => task.handedInAt !== null),
    tasks,
  }
}

/** Every session id the assignment's Jolli Code tasks were started under, for the local lookup. */
export function taskSessionIDs(assignment: StudentAssignment) {
  return assignment.parts
    .filter(isAgentPart)
    .filter((part) => part.workedIn === "jolli_code")
    .flatMap((part) => part.attempts.map((attempt) => attempt.conversationId))
}

/**
 * WHETHER A PART IS AN AGENT'S, AND SO MAY BE WORKED HERE.
 *
 * ⚠ BY ITS AGENT, NOT ITS `kind`, which a server that predates task kinds leaves out of an agent part.
 */
export function isAgentPart(part: StudentAssignmentPart): part is StudentAssignmentAgentPart {
  return "assistantId" in part
}

/**
 * Whether this session is the one handed in for its task, as the assignment read last says. A child
 * session asks with its root's id.
 */
export function handedInBy(assignment: Jolli.Assignment | undefined, task: TaskBinding, sessionID: string) {
  const found = assignment?.tasks.find((item) => item.partId === task.partId)
  return found?.handedInSessionID === sessionID
}

/** One assignment as the sidecar answered it, or why it could not. */
export type AssignmentRead =
  | { status: "ok"; assignment: Jolli.Assignment }
  | { status: "refused"; message: string }
  | { status: "unreachable" }

/** A sidecar answer as a renderer reads it: no answer, or an `ok` without an assignment, is unreachable. */
export function toRead(data: Jolli.AssignmentAnswer | undefined): AssignmentRead {
  if (!data || data.status === "unreachable") return { status: "unreachable" }
  if (data.status === "refused") return { status: "refused", message: data.message ?? "" }
  return data.assignment ? { status: "ok", assignment: data.assignment } : { status: "unreachable" }
}

// ── The hand-in permissions ──────────────────────────────────────────────────────────────────────

/** The permission the hand-in tool asks for: handing one task's session in. */
export const SUBMIT_TASK_PERMISSION = "jolli_submit_task"
/** The permission the turn-in tool asks for: turning the whole assignment in. */
export const TURN_IN_PERMISSION = "jolli_turn_in_assignment"

/** Both: the tools that ask for them are named after them, and offered only in a task's own session. */
export const HAND_IN_PERMISSIONS: ReadonlySet<string> = new Set([SUBMIT_TASK_PERMISSION, TURN_IN_PERMISSION])

/**
 * WHETHER A PERMISSION MAY ONLY EVER BE ANSWERED BY THE STUDENT'S OWN CLICK.
 *
 * ⚠ EVERY AUTO-APPROVAL ASKS THIS FIRST — a session's auto-accept, a batch approval of what is
 * pending, `--auto`, `--yolo`, a non-interactive run. Handing work in is final unless the teacher
 * reopens it, so what makes it count is that the student approved it; an approval nobody clicked is
 * not one.
 */
export function isNeverAutoApproved(permission: string) {
  return HAND_IN_PERMISSIONS.has(permission)
}

/**
 * WHAT A TERMINAL SAYS OVER A HAND-IN'S PERMISSION REQUEST: its title, and what its "always" covers.
 * The TUI's prompt and `run`'s share these; the desktop words them through its own translations.
 */
export const HAND_IN_PROMPT = {
  [SUBMIT_TASK_PERMISSION]: {
    title: "Submit task — final unless your teacher reopens it.",
    always: "This applies to this task only. You'll still be asked each time it is handed in.",
  },
  [TURN_IN_PERMISSION]: {
    title: "Turn in assignment — your teacher can review it once it's turned in.",
    always: "This applies to this assignment only. You'll still be asked to turn it in.",
  },
} as const

/**
 * WHAT A SURFACE THAT CANNOT ASK THE STUDENT ANSWERS A HAND-IN WITH — a non-interactive run, or an
 * editor over ACP. Passed to the agent as the student's word, so it says where to go instead.
 */
export const HAND_IN_ELSEWHERE =
  "Handing work in needs the student's own approval, which can't be given here. Hand it in from the Jolli Code desktop app or the jollicode terminal."

/**
 * WHAT "ALLOW ALWAYS" REMEMBERS FOR A HAND-IN: THIS ONE TASK, AND NOTHING THAT MATCHES ANOTHER.
 *
 * ⚠ NO WILDCARD, AND NEVER ONE OF THE REQUEST'S OWN LINES. The permission service approves later
 * requests whose every line matches what was remembered; a key no line can equal means a later
 * hand-in, with its own lines, is asked again.
 */
export function taskApprovalKey(courseId: string, assignmentId: string, partId: string) {
  return `course ${courseId} assignment ${assignmentId} task ${partId}`
}

/** The same, for turning one assignment in. */
export function assignmentApprovalKey(courseId: string, assignmentId: string) {
  return `course ${courseId} assignment ${assignmentId}`
}

/** The longest line a hand-in request carries, the reflection excepted. */
const MAX_LINE = 300

/**
 * THE LINES A HAND-IN'S PERMISSION REQUEST SHOWS THE STUDENT, IN ORDER, THE REFLECTION LAST.
 *
 * ⚠ FROM THE GATEWAY'S PREVIEW, NEVER FROM THE MODEL. What the student approves must be what is
 * handed in, so every line is read off what the gateway said it would keep.
 *
 * ⚠ THE REFLECTION WHOLE. The student is the last to read it before their teacher does.
 */
export function handInLines(preview: HandInPreview): string[] {
  const chat = preview.includes.summary
    ? preview.summary?.kind === "ready"
      ? "with an AI summary"
      : "without an AI summary (it could not be written)"
    : undefined
  return [
    `${preview.assignmentTitle} · ${preview.taskTitle} · ${preview.staffLabel}`,
    ...(preview.includes.transcript || preview.includes.summary
      ? [
          [`This chat up to now: ${preview.messageCount} ${preview.messageCount === 1 ? "message" : "messages"}`, chat]
            .filter(Boolean)
            .join(", "),
        ]
      : []),
    ...(preview.project ? [`Project: ${projectLine(preview.project)}`] : []),
    ...(preview.reflection !== null ? [`Reflection: “${preview.reflection}”`] : []),
  ].map((line, index, lines) => (index === lines.length - 1 && preview.reflection !== null ? line : clip(line)))
}

/** "github.com/cs310/lab4 · main · 3 commits (1 not pushed) · PR #3". */
export function projectLine(project: NonNullable<HandInPreview["project"]>) {
  const unpushed = project.commits.filter((commit) => !commit.pushed).length
  return [
    ...(project.remoteUrl ? [shownRemote(project.remoteUrl)] : []),
    ...(project.branch ? [project.branch] : []),
    ...(project.commits.length > 0
      ? [
          `${project.commits.length} ${project.commits.length === 1 ? "commit" : "commits"}` +
            (unpushed > 0 ? ` (${unpushed} not pushed)` : ""),
        ]
      : []),
    ...project.pullRequests.map((pull) => `PR #${pull.number}`),
  ].join(" · ")
}

/** A remote as a person reads it: no scheme, no `git@`, no `.git`. */
function shownRemote(remote: string) {
  return remote
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/\.git$/, "")
}

function clip(line: string) {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line
}

/**
 * WHY AN ASSIGNMENT CANNOT BE TURNED IN YET, NAMING WHAT IS LEFT — or undefined when nothing here says
 * it cannot.
 *
 * ⚠ ASKED BEFORE THE STUDENT IS. A permission prompt for a turn-in the gateway will refuse asks the
 * student to approve something that cannot happen; the tasks still owed are what they need to hear.
 *
 * ⚠ A CLOSED OR PAST-DUE ASSIGNMENT WITH EVERY TASK IN IS LEFT TO THE GATEWAY, which words that refusal
 * with the assignment's own dates.
 */
export function turnInBlocker(assignment: Jolli.Assignment): string | undefined {
  if (assignment.turnedIn) return `${assignment.title} is already turned in.`
  const left = assignment.tasks.filter((task) => task.owed && task.handedInAt === null)
  if (left.length === 0) return undefined
  const named = left.map(
    (task) => `${task.title} (${task.name})` + (task.place === "web" ? ", which is done on the web" : ""),
  )
  return `${assignment.title} can't be turned in yet. Still to hand in: ${named.join("; ")}.`
}

/**
 * The lines turning an assignment in shows: what it is, who reads it, and when each task went in.
 * Read off the assignment the turn-in names, as the gateway answered it.
 */
export function turnInLines(assignment: Jolli.Assignment, locale?: string): string[] {
  const day = (at: string) => new Date(at).toLocaleDateString(locale, { month: "short", day: "numeric" })
  return [
    [
      assignment.title,
      ...(assignment.dueAt ? [`due ${day(assignment.dueAt)}`] : []),
      assignment.authorName ?? "your teacher",
    ].join(" · "),
    ...assignment.tasks
      .filter((task) => task.owed)
      .map((task) =>
        task.handedInAt
          ? `${task.title} · ${task.name} · submitted ${day(task.handedInAt)}`
          : `${task.title} · ${task.name} · not submitted`,
      ),
  ].map(clip)
}
