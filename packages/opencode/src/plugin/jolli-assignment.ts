/**
 * HANDING A TASK IN, AND TURNING ITS ASSIGNMENT IN, FROM THE SESSION THE TASK STARTED.
 *
 * ⚠ THE STUDENT'S CLICK IS WHAT HANDS WORK IN, NEVER THE MODEL'S CALL. Each tool asks the gateway what
 * it would keep, shows exactly that in the permission request, and hands in only once the student
 * approves. The model chooses when to ask; it cannot choose what is handed in, nor answer for them —
 * `session/tools.ts` puts an "ask" rule after every other, and both renderers refuse to auto-approve
 * these two permissions.
 *
 * ⚠ ONLY IN A TASK'S OWN SESSION. `session/tools.ts` offers the tools nowhere else, a child session
 * included; the binding read here is the second check, and the gateway, which knows which session the
 * task was started under, is the last.
 *
 * ⚠ A REFUSAL IS AN ANSWER THE MODEL PASSES ON, NOT AN ERROR. The gateway words every refusal with its
 * next step; the tool returns that sentence as its output so the agent can say it, and keep talking.
 * The same goes for the student declining: nothing was handed in, and the chat goes on.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  failureOf,
  fetchStudentAssignment,
  handIn,
  JolliApiError,
  previewHandIn,
  scopedRequest,
  turnInAssignment,
  type GatewayRequest,
} from "@opencode-ai/core/jolli/api"
import {
  assignmentApprovalKey,
  HAND_IN_ELSEWHERE,
  handInLines,
  isAgentPart,
  projectAssignment,
  requiresExplicitSubmit,
  SUBMIT_TASK_PERMISSION,
  taskApprovalKey,
  taskBindingOf,
  TURN_IN_PERMISSION,
  turnInBlocker,
  turnInLines,
} from "@opencode-ai/core/jolli/assignment"
import { JolliAssignmentCache } from "@opencode-ai/core/jolli/assignment-cache"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import { parseCourseBinding, type OrgScope } from "@opencode-ai/core/jolli/org-scoped-id"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { EffectBridge } from "@/effect/bridge"
import { Git } from "@/git"
import { readProjectReport } from "@/jolli/project-report"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"

const NOT_A_TASK =
  "This chat wasn't started from an assignment task, so nothing can be handed in from it. Open the task from TODO Assignments (or /assignment in the terminal) and hand it in from that chat."

/** What each tool does, as its sentences to the student name it. */
const HAND_IN = { noun: "hand-in", done: "handed in" } as const
const TURN_IN = { noun: "turn-in", done: "turned in" } as const
type Act = typeof HAND_IN | typeof TURN_IN

const unreachable = (act: Act) => `Jolli couldn't be reached, so nothing was ${act.done}. Try again in a minute.`
const declined = (act: Act) =>
  `The student declined. Nothing was ${act.done}. Tell them that's fine, and to say when they're ready.`
const stopped = (act: Act) => `The student stopped this turn. Nothing was ${act.done}.`
const unconfirmed = (act: Act) =>
  `Jolli didn't confirm the ${act.noun}, and couldn't be asked whether it went through. Don't call this tool again yet: ask the student to check the assignment in TODO Assignments (or /assignment in the terminal) first.`

/** What a tool needs of the session it runs in: its course, its task, and when it started. */
type TaskSession = {
  /** The course as the session is bound to it, an org-scoped id: what approvals and kept copies are filed under. */
  courseId: string
  /** The course's org, which every call about the task is made in, and its numeric id there. */
  course: { readonly org?: OrgScope; readonly id: number }
  assignmentId: string
  partId: string
  startHead: string | undefined
  startedAt: number
}

export async function JolliAssignmentPlugin(
  _input: PluginInput,
  options: { bridge: EffectBridge.Shape },
): Promise<Hooks> {
  const run = <A>(effect: Effect.Effect<A, never, Session.Service | JolliSession.Service | Git.Service>) =>
    options.bridge.promise(effect)

  /** The session's task, or undefined for any session a task did not start. */
  function taskSessionOf(sessionID: string) {
    return run(
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const info = yield* sessions.get(SessionID.make(sessionID))
        const binding = courseBindingOf(info)
        const task = taskBindingOf(info)
        // A binding that does not parse names no course the task could be handed in to.
        const ids = parseCourseBinding(binding)
        if (!binding || !ids || !task) return undefined
        return {
          courseId: binding.courseId,
          course: { org: ids.org, id: ids.courseId },
          assignmentId: task.assignmentId,
          partId: task.partId,
          startHead: task.startHead,
          startedAt: info.time.created,
        } satisfies TaskSession
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
    )
  }

  /**
   * A gateway request with a fresh token, made in the org of the task's course, or undefined when
   * there is none to make.
   */
  function gateway(task: TaskSession) {
    return run(
      Effect.gen(function* () {
        const jolli = yield* JolliSession.Service
        const request = yield* jolli.request()
        return request && scopedRequest(request, task.course.org)
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
    )
  }

  function project(task: TaskSession, cwd: string) {
    return run(
      Effect.gen(function* () {
        const git = yield* Git.Service
        return yield* readProjectReport({ git, cwd, startHead: task.startHead, startedAt: task.startedAt })
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
    )
  }

  /**
   * A gateway call, settled: its answer, or the sentence to tell the student instead.
   *
   * ⚠ ONLY A REFUSAL PROVES A WRITE DID NOT LAND. A timeout, a dropped connection, a 5xx from a proxy
   * in front of the gateway, or an answer that did not read may all come after the gateway kept it.
   * Such a failure is `unsure`, and the tool reads the assignment again rather than tell the student
   * to retry: a second hand-in is refused as already handed in, in words that read as work lost.
   */
  async function call<A>(request: GatewayRequest, effect: Effect.Effect<A, JolliApiError>, act: Act, write = false) {
    return run(
      effect.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.status === 401) {
              const jolli = yield* JolliSession.Service
              yield* jolli.refused(request.token).pipe(Effect.catch(() => Effect.void))
            }
            yield* Effect.logWarning("Jolli: assignment hand-in call failed", {
              path: error.path,
              status: error.status,
              code: error.code,
            })
            const failure = failureOf(error)
            const told =
              failure === "refused"
                ? (error.explanation ?? `Jolli refused the ${act.noun}. Nothing was ${act.done}.`)
                : unreachable(act)
            return { ok: false as const, told, unsure: write && failure === "failed" }
          }),
        ),
      ),
    )
  }

  /** The assignment as the gateway now has it, or undefined when it cannot be read either. */
  function reread(request: GatewayRequest, task: TaskSession) {
    return run(
      fetchStudentAssignment(request, task.course.id, Number(task.assignmentId)).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    )
  }

  /**
   * A HAND-IN WHOSE ANSWER NEVER CAME, SETTLED BY READING THE ASSIGNMENT AGAIN: the hand-in's result
   * when the task's submission is now this session, undefined when it is not, "unknown" when the
   * read fails too — and then the sidecar's copy is dropped, so the student's own look is fresh.
   */
  async function settleHandIn(request: GatewayRequest, task: TaskSession, sessionID: string) {
    const now = await reread(request, task)
    if (!now) {
      JolliAssignmentCache.forget(request.identity, task.courseId, task.assignmentId)
      return "unknown" as const
    }
    const part = now.parts.find((item) => String(item.id) === task.partId)
    // A participation receipt is no hand-in. A hand-in that landed stays one if the teacher has since
    // switched the task to participation, so the task's current mode is not consulted.
    if (!part || !isAgentPart(part) || part.submission?.completionKind === "participation") return undefined
    const handedIn = part.attempts.find((attempt) => attempt.id === part.submission?.attemptId)
    if (handedIn?.conversationId !== sessionID) return undefined
    return { part, owedCount: now.progress.partsTotal - now.progress.partsSubmitted }
  }

  return {
    tool: {
      [SUBMIT_TASK_PERMISSION]: tool({
        description: [
          "Hand in this assignment task: this chat up to now, with what the task asks for, for the student's teacher to review.",
          "Call it only when the student asks to hand the task in. Handing in is final unless their teacher reopens it.",
          "If the task asks for a reflection, ask the student the reflection question in the chat first, in your own message (never with the question tool), and wait for their answer. Pass their answer exactly as they typed it, or one passage of it, in `reflection` — never your own words.",
          "Call this tool on its own, not alongside other tools that ask for permission. The student sees exactly what will be handed in and approves it.",
          "If the result says nothing was handed in, tell the student why in your own words, with the next step it gives.",
          "If the result says no tasks are left to hand in, ask the student whether to turn the whole assignment in now; call jolli_turn_in_assignment only if they say yes.",
        ].join("\n"),
        args: {
          reflection: tool.schema
            .string()
            .optional()
            .describe(
              "The student's answer to the task's reflection question, word for word, when the task asks for one.",
            ),
        },
        async execute(args, context) {
          const task = await taskSessionOf(context.sessionID)
          if (!task) return NOT_A_TASK
          const request = await gateway(task)
          if (!request) return unreachable(HAND_IN)
          // A cached tool list may predate a teacher's change. Check the server before collecting
          // a project report or asking the student to approve disclosing any content.
          const current = await reread(request, task)
          const part = current?.parts.find((part) => String(part.id) === task.partId)
          if (current) JolliAssignmentCache.keep(request.identity, task.courseId, current, Date.now())
          if (part && isAgentPart(part) && !requiresExplicitSubmit(part)) {
            return "Nothing to turn in. This task counts as submitted when you send your first message. You can keep working until the assignment is turned in or its work window closes."
          }
          if (context.abort.aborted) return stopped(HAND_IN)
          const report = await project(task, context.directory)
          const ids = {
            courseId: task.course.id,
            assignmentId: Number(task.assignmentId),
            partId: Number(task.partId),
            publicSessionId: context.sessionID,
            ...(args.reflection === undefined ? {} : { reflection: args.reflection }),
            ...(report === undefined ? {} : { project: report }),
          }
          const preview = await call(
            request,
            previewHandIn(request, ids).pipe(Effect.provide(FetchHttpClient.layer)),
            HAND_IN,
          )
          if (!preview.ok) return preview.told
          // The preview can take a minute and a half; a turn stopped meanwhile must not ask, nor hand in.
          if (context.abort.aborted) return stopped(HAND_IN)

          const refused = await asked(HAND_IN, () =>
            context.ask({
              permission: SUBMIT_TASK_PERMISSION,
              patterns: handInLines(preview.value),
              always: [taskApprovalKey(task.courseId, task.assignmentId, task.partId)],
              metadata: {
                courseId: task.courseId,
                assignmentId: task.assignmentId,
                partId: task.partId,
                preview: preview.value,
              },
            }),
          )
          if (refused !== undefined) return refused
          if (context.abort.aborted) return stopped(HAND_IN)

          const handed = await call(
            request,
            handIn(request, { ...ids, throughSeq: preview.value.throughSeq }).pipe(
              Effect.provide(FetchHttpClient.layer),
            ),
            HAND_IN,
            true,
          )
          if (!handed.ok && !handed.unsure) return handed.told
          const result = handed.ok ? handed.value : await settleHandIn(request, task, context.sessionID)
          if (result === "unknown") return unconfirmed(HAND_IN)
          if (result === undefined) return unreachable(HAND_IN)
          JolliAssignmentCache.handedIn(request.identity, task.courseId, task.assignmentId, result.part, Date.now())
          const name = `${preview.value.assignmentTitle} · ${preview.value.taskTitle}`
          return {
            title: `Handed in ${name}`,
            output:
              result.owedCount === 0
                ? `Handed in ${name}. No tasks are left to hand in for ${preview.value.assignmentTitle}: ask the student whether to turn the whole assignment in now.`
                : `Handed in ${name}. ${result.owedCount} ${result.owedCount === 1 ? "task is" : "tasks are"} still to hand in for ${preview.value.assignmentTitle}.`,
            metadata: { owedCount: result.owedCount },
          }
        },
      }),
      [TURN_IN_PERMISSION]: tool({
        description: [
          "Turn in the assignment this chat's task belongs to, for the student's teacher to review. It needs every task handed in first.",
          "Call it only after the student said yes to turning the assignment in. The student sees what will be turned in and approves it.",
          "If the result says nothing was turned in, tell the student why in your own words, with the next step it gives.",
        ].join("\n"),
        args: {},
        async execute(_args, context) {
          const task = await taskSessionOf(context.sessionID)
          if (!task) return NOT_A_TASK
          const request = await gateway(task)
          if (!request) return unreachable(TURN_IN)
          const read = await call(
            request,
            fetchStudentAssignment(request, task.course.id, Number(task.assignmentId)).pipe(
              Effect.provide(FetchHttpClient.layer),
            ),
            TURN_IN,
          )
          if (!read.ok) return read.told
          if (context.abort.aborted) return stopped(TURN_IN)
          const assignment = projectAssignment({ id: task.courseId, code: "" }, read.value, new Map(), Date.now())
          const blocked = turnInBlocker(assignment)
          if (blocked) return `Nothing was turned in. ${blocked}`

          const refused = await asked(TURN_IN, () =>
            context.ask({
              permission: TURN_IN_PERMISSION,
              patterns: turnInLines(assignment),
              always: [assignmentApprovalKey(task.courseId, task.assignmentId)],
              metadata: { courseId: task.courseId, assignmentId: task.assignmentId, assignment },
            }),
          )
          if (refused !== undefined) return refused
          if (context.abort.aborted) return stopped(TURN_IN)

          const turned = await call(
            request,
            turnInAssignment(request, {
              courseId: task.course.id,
              assignmentId: Number(task.assignmentId),
            }).pipe(Effect.provide(FetchHttpClient.layer)),
            TURN_IN,
            true,
          )
          if (!turned.ok && !turned.unsure) return turned.told
          // A turn-in whose answer never came is settled the same way: read the assignment again.
          const now = turned.ok ? turned.value : await reread(request, task)
          if (!now) {
            JolliAssignmentCache.forget(request.identity, task.courseId, task.assignmentId)
            return unconfirmed(TURN_IN)
          }
          if (!turned.ok && now.progress.turnedInAt === null) return unreachable(TURN_IN)
          JolliAssignmentCache.turnedIn(request.identity, task.courseId, now, Date.now())
          return { title: `Turned in ${assignment.title}`, output: `Turned in ${assignment.title}.` }
        },
      }),
    },
  }
}

/**
 * Ask the student, and answer what to tell the model when they said no — undefined when they approved.
 *
 * ⚠ THREE KINDS OF NO, ONE ANSWER. The student pressing Deny, Deny with a note, and a rule in their
 * config that denies these permissions all mean nothing was handed in. A note is passed on: it is the
 * student talking to the agent.
 *
 * ⚠ ANYTHING ELSE IS NOT A NO. The session being stopped, or a failure of the request itself, is
 * thrown on, so the turn ends as it would for any tool rather than the agent being told the student
 * declined.
 */
async function asked(act: Act, ask: () => Promise<void>) {
  try {
    await ask()
    return undefined
  } catch (error) {
    // A surface that cannot ask the student — a run, an editor over ACP — says where to hand in instead.
    if (error instanceof PermissionV1.CorrectedError && error.feedback === HAND_IN_ELSEWHERE) {
      return `Nothing was ${act.done}. ${HAND_IN_ELSEWHERE}`
    }
    if (error instanceof PermissionV1.CorrectedError && error.feedback.trim() !== "") {
      return `${declined(act)}\nThe student said: ${error.feedback}`
    }
    if (
      error instanceof PermissionV1.RejectedError ||
      error instanceof PermissionV1.CorrectedError ||
      error instanceof PermissionV1.DeniedError
    )
      return declined(act)
    throw error
  }
}
