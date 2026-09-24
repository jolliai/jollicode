import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@opencode-ai/core/util/error"
import { isJolliProviderId } from "@opencode-ai/core/jolli/gateway-config"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { syncTitle } from "@opencode-ai/core/jolli/title"
import { Cause, Effect, Option, Schema, Scope } from "effect"
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
export function preserveBinding(before: Record<string, unknown> | undefined, after: Record<string, unknown>) {
  const previous = before?.["jolli"]
  if (previous === undefined || "jolli" in after) return after
  return { ...after, jolli: previous }
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
  if (!(yield* started().pipe(Effect.catchCause(() => Effect.succeed(true))))) return
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

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
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
        yield* refuseRebindingAfterFirstMessage(current.metadata, metadata, () =>
          session.hasMessages({ sessionID: ctx.params.sessionID }),
        )
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
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(
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
      return yield* session.updatePart(payload)
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
