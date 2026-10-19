import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Git } from "@/git"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { JolliInput } from "@/session/jolli-input"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import { isJolliProviderId } from "@opencode-ai/core/jolli/gateway-config"
import { JolliApiError, openConversation, startTaskSession } from "@opencode-ai/core/jolli/api"
import { TASK_KEY, taskBindingOf, taskRecord } from "@opencode-ai/core/jolli/assignment"
import { courseBindingOf, isGatewayId, type CourseBinding } from "@opencode-ai/core/jolli/binding"
import { JolliClosedAssistants } from "@opencode-ai/core/jolli/closed-assistants"
import { JolliCourseGuardrails } from "@opencode-ai/core/jolli/course-guardrails"
import { openedOnGateway, openerTextOf } from "@opencode-ai/core/jolli/opener"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { syncTitle } from "@opencode-ai/core/jolli/title"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect/instance-state"
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  JolliStartPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { PermissionNotFoundError } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

/**
 * CARRY A SESSION'S BINDING ACROSS A METADATA WRITE THAT SAYS NOTHING ABOUT IT.
 *
 * ⚠ `setMetadata` REPLACES THE WHOLE BAG, WHICH MAKES "NOT MENTIONING THE BINDING" AND "ERASING IT"
 * THE SAME REQUEST. Today this repo has exactly one writer of session metadata, so nothing has been
 * lost yet — but the guard below is written as though the bag is shared, and the first feature to
 * write its own key would silently unbind every session it touched. Re-attaching the existing
 * binding is what makes both statements true at once: an unrelated write keeps it, and a write that
 * carries a DIFFERENT binding still reaches the guard and is judged on its merits.
 */
export function preserveBinding(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const previous = before?.["jolli"]
  /**
   * ⚠ THE OPENER IS THE SERVER'S, SO NO WRITE MAY SET, CHANGE OR DROP IT. Only the start route puts
   * it there, from what the gateway answered; a client that could write it could put words in the
   * agent's mouth on screen. It is kept apart from `jolli` because a visibility toggle rewrites that
   * whole object.
   */
  const opener = before?.["jolliOpener"]
  /** ⚠ A TASK'S RECORD IS THE SERVER'S FOR THE SAME REASON: see `TASK_KEY`. */
  const task = before?.[TASK_KEY]
  const rest = Object.fromEntries(Object.entries(after).filter(([key]) => key !== "jolliOpener" && key !== TASK_KEY))
  return {
    ...rest,
    ...(previous === undefined || "jolli" in after ? {} : { jolli: previous }),
    ...(opener === undefined ? {} : { jolliOpener: opener }),
    ...(task === undefined ? {} : { [TASK_KEY]: task }),
  }
}

/** The two fields of a session's binding that stop being writable. Anything else in there is not. */
function boundTo(metadata: Record<string, unknown> | undefined) {
  const jolli = metadata?.["jolli"]
  if (!jolli || typeof jolli !== "object") return undefined
  const value = jolli as { courseId?: unknown; assistantId?: unknown }
  if (typeof value.courseId !== "string" || typeof value.assistantId !== "string") return undefined
  return { courseId: value.courseId, assistantId: value.assistantId }
}

/**
 * A SESSION'S COURSE AND ASSISTANT STOP BEING WRITABLE ONCE THE CONVERSATION HAS BEGUN.
 *
 * ⚠ THIS IS THE ONLY PLACE THE LOCK IS REAL. The renderer enforces it by rendering no control —
 * the course pickers exist on the new-session screen and nowhere else — which is honest about
 * screens and says nothing about the API. A course decides which models may run and who may read
 * the transcript, so letting it be rewritten mid-conversation would retroactively re-scope work
 * already done under different terms.
 *
 * ⚠ THE LINE IS THE FIRST MESSAGE, NOT THE SESSION'S EXISTENCE. Creating a session and sending the
 * first prompt happen in one submit, so a student never observes the gap — but the CLI can create a
 * session and stop, and a crash can leave one half-made. Both should still be bindable.
 *
 * ⚠ EXCEPT A SESSION STARTED ON THE GATEWAY, WHICH IS LOCKED BEFORE ANY MESSAGE. Start creates the
 * conversation there, bound, before the student says anything, and its opener is not a message.
 * Rebinding it locally would leave every later turn refused as a binding conflict, so a session
 * Start recorded as its own (`openedOnGateway`) counts as started — with an opener or without one.
 *
 * ⚠ AND A SESSION THAT STARTED UNBOUND IS COVERED TOO, WHICH IS EASY TO LEAVE OUT. The comparison
 * below treats "no binding" as a value rather than as a reason to skip the check, because the CLI
 * and the TUI create sessions with no metadata at all: a conversation can run to completion unbound
 * and then be handed a course afterwards. That is the same retroactive re-scoping as a rewrite —
 * the transcript becomes readable under terms that did not apply while it was being written — so
 * the first binding is refused after the first message for exactly the same reason a second one is.
 *
 * ⚠ AND IT COMPARES, RATHER THAN REFUSING EVERY METADATA WRITE. Metadata is a shared bag: other
 * features write to it on live sessions, and rejecting those would be a lock on the wrong thing.
 * Re-writing the SAME binding is also allowed, so an idempotent retry is not an error.
 */
export const refuseRebindingAfterFirstMessage = Effect.fn("SessionHttpApi.refuseRebinding")(function* (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  started: () => Effect.Effect<boolean, unknown>,
  sessionID: string,
) {
  const previous = boundTo(before)
  const next = boundTo(after)
  /**
   * ⚠ ONLY THE COURSE AND THE ASSISTANT ARE COMPARED, NOT THE WHOLE `jolli` OBJECT. Visibility
   * lives in there too and IS a student's to change on a live session — comparing the object
   * wholesale would refuse every privacy toggle after the first message, which is the one part of
   * a binding this lock is not meant to cover.
   *
   * ⚠ AND BOTH SIDES MAY BE ABSENT. Unbound-to-unbound compares equal and passes straight through,
   * which is what keeps an ordinary metadata write on a session that has no course free of charge.
   */
  if (previous?.courseId === next?.courseId && previous?.assistantId === next?.assistantId) return

  /**
   * ⚠ "HAS IT STARTED" IS "IS THERE ANY MESSAGE", NOT "IS THE NEWEST ONE A USER MESSAGE". An
   * earlier cut asked for one message and checked its role, which reads correctly and is exactly
   * backwards: `Session.messages` with a limit pages from `desc(time_created)`, so the one it
   * returns is the LATEST. In the steady state that is an assistant reply, so the check passed and
   * the lock never engaged on any session that had been answered — which is every session it was
   * meant to protect.
   *
   * ⚠ AND A READ FAILURE REFUSES RATHER THAN PERMITS. This is a lock; "I could not tell" must not
   * mean "go ahead".
   *
   * ⚠ WHICH IS WHY IT IS `catchCause` AND NOT `catch`. The only caller reads the database through
   * `MessageV2.exists`, which is `Effect.orDie` — so a database that will not answer arrives as a
   * DEFECT, and `Effect.catch` handles typed failures only. It went straight past the handler and
   * killed the request: still fail-closed, by luck rather than by the rule stated above, and a 500
   * where this is meant to answer 400. Catching the cause is what makes the sentence true.
   */
  const opened = openedOnGateway({ id: sessionID, metadata: before })
  if (!opened && !(yield* started().pipe(Effect.catchCause(() => Effect.succeed(true))))) return
  /**
   * ⚠ THE REASON GOES IN THE LOG, NOT THE BODY. `HttpApiError.BadRequest` carries no message field,
   * and the only caller that can trip this is a client rewriting a binding it was never offered a
   * control for — so the audience for the explanation is whoever is reading server logs, not a
   * screen.
   */
  yield* Effect.logWarning("Jolli: refused to rebind a session that has already started", {
    before: previous,
    after: next,
  })
  return yield* Effect.fail(new HttpApiError.BadRequest({}))
})

/**
 * A CHAT WHOSE AGENT SPEAKS FIRST IS BOUND BY START, NEVER BY A WRITE.
 *
 * ⚠ THE COMPOSER'S START BUTTON IS A SCREEN, NOT A RULE. Both renderers put Start where the input
 * would be for such an assistant, but `session.create` or a metadata `PATCH` carrying its binding
 * would still make a session the gateway opens on the student's first message — with no opener, so
 * the greeting the teacher wrote is skipped and nobody is told.
 *
 * ⚠ ONLY A NEW BINDING IS JUDGED. Rewriting the binding a session already has — a visibility toggle,
 * an idempotent retry — passes, so a session bound before its assistant was switched to speak first
 * keeps working. A session Start made never reaches the lookup for the same reason.
 *
 * ⚠ "CANNOT TELL" PERMITS. The answer comes from the catalogue on disk; without one there is nothing
 * to judge by, and refusing would stop a plain chat being made over a check that is about an opener.
 * The gateway still applies the course to every turn either way.
 *
 * ⚠ A FORK IS NOT JUDGED HERE. It copies a conversation that already went past its opener, so the
 * greeting this protects was either read in the original or never written.
 *
 * ⚠ A BARE 400, WHICH THE DESKTOP READS AS "YOUR LIST IS OLD". The snapshot judged here can be newer
 * than the renderer's copy, so a composer may offer typing for an assistant that now speaks first;
 * `createPromptSubmit` refreshes the catalogue on a 400 for a bound create, and the fresh list puts
 * Start there. A reason in the body would need an error schema on the public `HttpApi` and both
 * SDKs regenerated, for a case the refresh already covers.
 */
export const refuseBindingOutsideStart = Effect.fn("SessionHttpApi.refuseBindingOutsideStart")(function* (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  opens: (binding: CourseBinding) => Effect.Effect<boolean | undefined>,
) {
  const next = boundTo(after)
  if (!next) return
  const previous = boundTo(before)
  if (previous?.courseId === next.courseId && previous.assistantId === next.assistantId) return
  if (!(yield* opens(next))) return
  yield* Effect.logWarning("Jolli: refused to bind a session to an assistant that speaks first", { binding: next })
  return yield* Effect.fail(new HttpApiError.BadRequest({}))
})

/**
 * START A SESSION WHOSE AGENT SPEAKS FIRST: THE GATEWAY BEFORE THE LOCAL SESSION.
 *
 * ⚠ THE ORDER IS THE WHOLE DESIGN. The opener exists only once the gateway has created the
 * conversation, and a refused or failed Start must leave nothing behind — no empty local session for
 * the student to stumble into later. So the id is minted here, the gateway is asked under it, and
 * the local session is created with that same id only after it answered.
 *
 * ⚠ A FAILURE IS NEVER TREATED AS "NO OPENER". The gateway may have stored an opener the student
 * never saw; starting the chat anyway would have the model continue a greeting nobody read. Only a
 * success without one starts a plain session.
 *
 * ⚠ A RETRY REUSES THE ID, AND THAT IS WHAT MAKES IT SAFE. The gateway is idempotent by id — asked
 * again it answers with the conversation it already made, opener included — so a client whose Start
 * got no answer sends the same id rather than leaving an orphan conversation behind a fresh one. And
 * when the first try did get as far as the local session, its answer is that session.
 *
 * ⚠ THE CREDENTIAL, THE LOOKUP AND THE CREATE ARE PARAMETERS so all of this can be tested without a
 * server.
 */
export const startJolliSession = Effect.fn("SessionHttpApi.startJolliSession")(function* (input: StartInput) {
  if (!isGatewayId(input.payload.courseId) || !isGatewayId(input.payload.assistantId))
    return yield* new HttpApiError.BadRequest({})
  // A task is named whole or not at all: half of one is no task the gateway could start.
  if ((input.payload.assignmentId === undefined) !== (input.payload.partId === undefined))
    return yield* new HttpApiError.BadRequest({})
  if (
    input.payload.assignmentId !== undefined &&
    (!isGatewayId(input.payload.assignmentId) || !isGatewayId(input.payload.partId ?? ""))
  )
    return yield* new HttpApiError.BadRequest({})
  const id = input.payload.sessionID ?? SessionID.descending()
  return yield* startLock.withLock(id)(startUnder(id, input))
})

/**
 * ⚠ ONE START PER ID AT A TIME. A retry can arrive while the first try is still waiting on the
 * gateway — up to 45 seconds — and without this both would pass the `existing` check, both open the
 * (idempotent) conversation, and the second create would collide with the first: a 500 where the
 * contract promises the same session. Queued, the retry finds the session the first one made.
 */
const startLock = KeyedMutex.makeUnsafe<SessionID>()

type StartInput = {
  payload: typeof JolliStartPayload.Type
  /** The directory this Start was asked in — where a session it creates would live. */
  directory: string
  gateway: Pick<JolliSession.Interface, "request" | "refused">
  existing: (id: SessionID) => Effect.Effect<Session.Info | undefined>
  create: (input: Session.CreateInput & { id: SessionID }) => Effect.Effect<Session.Info>
  /**
   * The commit the folder's HEAD is at, or undefined outside a repository or before its first commit.
   * Read for a task's session only: its hand-in reports the commits made since.
   */
  head: () => Effect.Effect<string | undefined>
}

/** The task a Start names, when it names one. */
function taskOf(payload: typeof JolliStartPayload.Type) {
  return payload.assignmentId !== undefined && payload.partId !== undefined
    ? { assignmentId: payload.assignmentId, partId: payload.partId }
    : undefined
}

const startUnder = Effect.fn("SessionHttpApi.startUnder")(function* (id: SessionID, input: StartInput) {
  const previous = input.payload.sessionID ? yield* input.existing(id) : undefined
  if (previous) return yield* alreadyStarted(previous, input)
  const request = yield* input.gateway.request().pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!request) return { status: "unreachable" as const }
  const named = taskOf(input.payload)
  /**
   * ⚠ A TASK'S SESSION IS OPENED BY THE TASK, NOT BY THE ASSISTANT. The gateway records the attempt
   * with the session in one step, and refuses a task the student cannot start now in the assignment's
   * own words; opening the assistant's conversation instead would make a plain chat the task could
   * never be handed in from.
   */
  const opened = yield* (
    named
      ? startTaskSession(request, {
          courseId: Number(input.payload.courseId),
          assignmentId: Number(named.assignmentId),
          partId: Number(named.partId),
          publicSessionId: id,
        })
      : openConversation(request, {
          spaceId: Number(input.payload.courseId),
          courseAssistantId: Number(input.payload.assistantId),
          publicSessionId: id,
        })
  ).pipe(Effect.catch((error) => Effect.succeed(error)))
  if (opened instanceof JolliApiError)
    return yield* startRefused(input.gateway, opened, request.token, input.payload.assistantId, named !== undefined)
  const task = named
    ? { ...named, ...(yield* input.head().pipe(Effect.map((head) => (head ? { startHead: head } : {})))) }
    : undefined
  const session = yield* input.create({
    id,
    title: input.payload.title,
    agent: input.payload.agent,
    model: input.payload.model,
    permission: input.payload.permission ? [...input.payload.permission] : undefined,
    workspaceID: input.payload.workspaceID,
    /**
     * ⚠ `jolliOpener` IS WRITTEN EVEN WITHOUT AN OPENER. Its `sessionID` is the record that the
     * gateway's conversation exists and is bound, which is what locks the binding before the first
     * message; only `text` depends on what the gateway answered.
     */
    metadata: {
      // A task's session is recorded under the agent the gateway bound it to, which every turn is checked against.
      jolli:
        "binding" in opened
          ? opened.binding
          : { courseId: input.payload.courseId, assistantId: input.payload.assistantId },
      jolliOpener: { sessionID: id, ...(opened.opener ? { text: opened.opener } : {}) },
      ...(task ? { [TASK_KEY]: taskRecord(id, task) } : {}),
    },
  })
  return { status: "started" as const, session, opener: !!opened.opener }
})

/**
 * A retried Start whose session already exists: the same session, if it is the one this Start made.
 *
 * ⚠ ANYTHING ELSE UNDER THAT ID IS A BAD REQUEST. Another session, or this one under a different
 * binding, is not something a retry can have produced.
 */
/**
 * ⚠ THE SESSION A KNOWN ID ANSWERS WITH MUST LIVE WHERE THE RETRY WAS ASKED. A Start whose answer
 * was lost may have made its session already, and the client may then retry it from a draft in
 * another project; answering with that session would have the client file it under the project it
 * asked from and route there. Refused, the client lets the id go and starts over under a new one.
 */
const alreadyStarted = Effect.fn("SessionHttpApi.alreadyStarted")(function* (
  session: Session.Info,
  input: Pick<StartInput, "payload" | "directory">,
) {
  const bound = courseBindingOf(session)
  const task = taskBindingOf(session)
  const named = taskOf(input.payload)
  if (
    !openedOnGateway(session) ||
    bound?.courseId !== input.payload.courseId ||
    // A task's agent is the gateway's answer, which the Start retried may not have known.
    (named === undefined && bound.assistantId !== input.payload.assistantId) ||
    task?.assignmentId !== named?.assignmentId ||
    task?.partId !== named?.partId
  )
    return yield* new HttpApiError.BadRequest({})
  if (session.directory !== input.directory) {
    yield* Effect.logWarning("Jolli: refused a Start retried from another directory", {
      sessionID: session.id,
      session: session.directory,
      asked: input.directory,
    })
    return yield* new HttpApiError.BadRequest({})
  }
  return { status: "started" as const, session, opener: openerTextOf(session) !== undefined }
})

/**
 * ⚠ A 401 RENEWS THE CREDENTIAL, as the Jolli routes do, and still answers `unreachable`: the
 * gateway created nothing, so trying again with the renewed token is safe.
 */
const startRefused = Effect.fn("SessionHttpApi.startRefused")(function* (
  gateway: Pick<JolliSession.Interface, "refused">,
  error: JolliApiError,
  token: string,
  assistantId: string,
  /** A task's start, whose refusals the gateway words in the assignment's terms. */
  forTask: boolean,
) {
  if (error.status === 401) yield* gateway.refused(token).pipe(Effect.catch(() => Effect.void))
  /**
   * ⚠ A 2XX THAT WOULD NOT DECODE IS A FAILURE, NOT A REFUSAL. The gateway created the conversation,
   * so nothing about the course or assistant changed, and this client cannot tell what it said —
   * refreshing the catalogue and telling the student the chat was refused would both be wrong.
   */
  if (error.status === undefined || error.status < 300 || error.status === 401 || error.status >= 500) {
    yield* Effect.logWarning("Jolli: start failed", { status: error.status, cause: error.cause })
    return { status: "unreachable" as const }
  }
  yield* Effect.logInfo("Jolli: start refused", { status: error.status, code: error.code })
  /**
   * ⚠ A 404 WITH NO CODE IS A COURSE OR ASSISTANT THAT IS GONE — missing, archived or hidden, which
   * the gateway deliberately does not tell apart. The code a session's later turns would get for the
   * same thing names it.
   */
  const code = error.code ?? (error.status === 404 ? "assistant_not_found" : undefined)
  /**
   * ⚠ A CLOSED REFUSAL IS REMEMBERED, so the catalogue the renderer asks for next stops offering the
   * assistant even when its clock still reads the window as open.
   */
  if (code === "assistant_closed") JolliClosedAssistants.record(assistantId)
  return {
    status: "refused" as const,
    ...(code === undefined ? {} : { code }),
    /**
     * ⚠ ONLY A TASK'S REFUSAL CARRIES THE GATEWAY'S SENTENCE. It names the assignment's dates and what
     * to do, which no table here could; an assistant's refusal is worded by its code, through each
     * renderer's own dictionary.
     */
    ...(forTask && error.explanation !== undefined ? { message: error.explanation } : {}),
  }
})

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const jolli = yield* JolliSession.Service
    const git = yield* Git.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const opensConversation = (binding: CourseBinding) =>
      JolliCourseGuardrails.opensConversation(binding).pipe(Effect.provideService(JolliSession.Service, jolli))

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      yield* refuseBindingOutsideStart(undefined, ctx.payload?.metadata, opensConversation)
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const jolliStart = Effect.fn("SessionHttpApi.jolliStart")(function* (ctx: {
      payload: typeof JolliStartPayload.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* startJolliSession({
        payload: ctx.payload,
        directory: instance.directory,
        gateway: jolli,
        existing: (id) => session.get(id).pipe(Effect.option, Effect.map(Option.getOrUndefined)),
        create: shareSvc.create,
        head: () =>
          git
            .run(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: instance.directory })
            .pipe(Effect.map((result) => (result.exitCode === 0 ? result.text().trim() || undefined : undefined))),
      }).pipe(Effect.provide(FetchHttpClient.layer))
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      /**
       * ⚠ THE BINDING IS JUDGED BEFORE ANYTHING IS WRITTEN, AND THE ORDER IS THE POINT. This
       * handler applies four independent fields in sequence with no transaction around them, so a
       * guard placed next to the field it guards lets the earlier ones land on a request that then
       * answers 400 — a rename that happened on a `PATCH` the API reports as rejected. Deciding
       * first is the cheapest way to make the refusal mean "nothing changed".
       */
      const metadata =
        ctx.payload.metadata !== undefined ? preserveBinding(current.metadata, ctx.payload.metadata) : undefined
      if (metadata !== undefined) {
        yield* refuseRebindingAfterFirstMessage(
          current.metadata,
          metadata,
          () => session.hasMessages({ sessionID: ctx.params.sessionID }),
          ctx.params.sessionID,
        )
        yield* refuseBindingOutsideStart(current.metadata, metadata, opensConversation)
      }

      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
        /**
         * ⚠ ONLY A SESSION THAT HAS PROMPTED A JOLLI MODEL HAS A CONVERSATION TO RENAME. `model` is
         * written by the first prompt, so its absence means nothing reached the gateway yet — the
         * first turn pushes that title instead (`SessionPrompt.ensureTitle`). Forked so a slow or
         * absent gateway never holds up the rename the student is looking at.
         */
        if (current.model && isJolliProviderId(current.model.providerID)) {
          yield* syncTitle(ctx.params.sessionID, ctx.payload.title).pipe(
            Effect.provideService(JolliSession.Service, jolli),
            Effect.provide(FetchHttpClient.layer),
            Effect.forkIn(scope),
          )
        }
      }
      if (metadata !== undefined) {
        yield* session.setMetadata({ sessionID: ctx.params.sessionID, metadata })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const message = yield* promptSvc
        .prompt({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
          typed: "student",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID, typed: "student" }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      // Which text the student typed is never the client's to say: the part keeps the server's stamps.
      const stored = yield* session.getPart(ctx.params)
      const message = yield* MessageV2.getInfo({
        sessionID: ctx.params.sessionID,
        messageID: ctx.params.messageID,
      }).pipe(Effect.option)
      return yield* session.updatePart(
        JolliInput.keepStamps(payload, stored, Option.isSome(message) ? message.value.role : undefined),
      )
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("jolliStart", jolliStart)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
