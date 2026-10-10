/**
 * BINDING JOLLICODE'S SESSION → JOLLIEDU'S COURSE-CHAT MCP.
 *
 * ⚠ THE JOLLIEDU MCP COURSE TOOLS TAKE `courseId` AND `assistantId` AS ARGUMENTS,
 * DELIBERATELY. The server is stateless — it validates them against the caller's
 * identity on every call — so the same tool code serves any conversation without
 * a stateful session at the server end. But those two ids are NOT the model's to
 * choose: they are the session's server-owned binding, written into
 * `session.metadata.jolli` when the session was created (see
 * `packages/core/src/jolli/binding.ts`). This plugin bridges that gap.
 *
 * ⚠ IT OVERWRITES RATHER THAN COMPLEMENTS. Before a course-bound `jolliedu_*` tool call goes
 * out, the plugin reads the current session's binding and REPLACES whatever the model
 * put in `courseId`/`assistantId`. A model that left them unset gets them filled in;
 * a model that guessed at them cannot reach a course the session is not bound to,
 * because whatever it guessed is discarded here.
 *
 * ⚠ THE SERVER SCHEMA STILL DECLARES THE TWO FIELDS. The model-facing projection removes
 * them so the model can call the tool without knowing internal ids; the execute hook then injects
 * them before the request reaches MCP. The server keeps both fields in its schema and validates
 * the resulting request normally.
 *
 * ⚠ A COURSE TOOL REQUIRES A VALID SESSION BINDING. A missing or malformed binding
 * stops the call before it reaches MCP, including when the model supplied ids.
 *
 * ⚠ LIST CURSORS LIVE IN THIS PLUGIN, NOT IN `session.metadata`. A renderer's metadata write
 * replaces the whole bag, so a cursor stored there vanished on the next unrelated PATCH, and the
 * read-modify-write needed to store it could put back a bag a renderer had just changed. A cursor
 * only means something to the process that served its page, so a restart forgetting it costs the
 * student a fresh first page rather than a wrong one. The same holds for the bound on how many
 * sessions keep one: the least recently paged session is dropped first.
 *
 * ⚠ A CONTINUATION WAITS FOR AN EARLIER ONE OF THE SAME LIST, BUT ONLY SO LONG. The cursor is read
 * before a page is fetched and written after, so two continuations in flight at once — a parallel
 * tool step, or `Promise.all` in code mode — read the same cursor and fetch the same page twice.
 * The later one therefore waits for the earlier one to report back before reading. The wait is
 * bounded because the after hook runs only when a call succeeds: a continuation that failed
 * would otherwise hold every later one of its list forever.
 *
 * ⚠ PAGING GUIDANCE LIVES IN THE TOOL DESCRIPTION AND THE RESULT, NEVER IN THE SYSTEM PROMPT. The
 * system block leads the cached prompt prefix, so a sentence there that follows the paging state
 * invalidated the cache for the whole history whenever a list was shown or ran out, and it rode
 * along on every request of the session, title generation included. The list tools' descriptions
 * already say when to pass `continue`, and each page's own `hasMore` says whether there is more.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import { JolliCourseGuardrails } from "@opencode-ai/core/jolli/course-guardrails"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Effect, Option, Schema } from "effect"
import type { EffectBridge } from "@/effect/bridge"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { isRecord } from "@/util/record"
import {
  COURSE_TOOL_IDS,
  courseToolBindingOf,
  kindOf,
  projectJolliToolDefinition,
  type ListKind,
} from "./jolli-mcp-tools"

type PagingState = {
  materials?: { nextCursor: number | null; courseId: number; assistantId: number }
  attachments?: { nextCursor: string | null }
}

/** Sessions whose cursors are kept. A long-lived desktop sidecar would otherwise keep one per session forever. */
const MAX_PAGED_SESSIONS = 256

/**
 * How long a continuation waits for an earlier one of the same list before reading the cursor
 * anyway. The MCP layer's default per-call timeout, so a healthy earlier call has always reported
 * back by then, and a failed one costs a later call this much latency rather than its answer.
 */
const PAGE_WAIT_MS = 30_000

/** A continuation that has read its cursor and not yet reported back, keyed by session and list. */
type InflightPage = { callID: string; settled: Promise<void>; release: () => void }

const decodePage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(Schema.Unknown),
      nextCursor: Schema.NullOr(Schema.Union([Schema.Number, Schema.String])),
      hasMore: Schema.Boolean,
    }),
  ),
)

export async function JolliCourseChatPlugin(
  _input: PluginInput,
  options: {
    bridge: EffectBridge.Shape
    pageWaitMs?: number
    /** Whether the session's course shows citations; see {@link citationsShownFor}. Replaced in tests. */
    citationsShown?: (sessionID: string) => Promise<boolean | undefined>
  },
): Promise<Hooks> {
  const paging = new Map<string, PagingState>()
  const inflight = new Map<string, InflightPage>()
  const pageWaitMs = options.pageWaitMs ?? PAGE_WAIT_MS
  const citationsShown = options.citationsShown ?? ((sessionID: string) => citationsShownFor(options.bridge, sessionID))

  /** Save a session's cursors as the most recently used, dropping the least recently used past the bound. */
  function remember(sessionID: string, state: PagingState) {
    paging.delete(sessionID)
    paging.set(sessionID, state)
    if (paging.size <= MAX_PAGED_SESSIONS) return
    const oldest = paging.keys().next().value
    if (oldest !== undefined) paging.delete(oldest)
  }

  /**
   * The session's course binding, or undefined when it has none. A session that cannot be read at
   * all is a different failure — a storage fault rather than an unbound conversation — so it is
   * logged and reported as one instead of being passed off as a missing binding.
   */
  async function bindingOf(sessionID: string) {
    const session = await options.bridge.promise(
      Effect.gen(function* () {
        const service = yield* Session.Service
        return yield* service.get(SessionID.make(sessionID))
      }).pipe(
        Effect.map((read) => ({ ok: true as const, read })),
        Effect.catchCause((cause) =>
          Effect.logWarning("jolli-course-chat: could not read the session for its course binding", {
            sessionID,
            cause: String(cause),
          }).pipe(Effect.as({ ok: false as const })),
        ),
      ),
    )
    if (!session.ok) throw new Error("Could not read this session's course binding. Try again.")
    return courseToolBindingOf(session.read)
  }

  /** Wait for an earlier continuation of this list to report back, for at most `pageWaitMs`. */
  async function afterEarlierPage(key: string) {
    const running = inflight.get(key)
    if (!running) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, pageWaitMs)
    })
    await Promise.race([running.settled, bound]).finally(() => clearTimeout(timer))
  }

  /** Mark this call as the continuation of its list now reading, so the next one waits for it. */
  function claimPage(key: string, callID: string) {
    const { promise, resolve } = Promise.withResolvers<void>()
    inflight.get(key)?.release()
    inflight.delete(key)
    inflight.set(key, { callID, settled: promise, release: resolve })
    if (inflight.size <= MAX_PAGED_SESSIONS) return
    const oldest = inflight.keys().next().value
    if (oldest === undefined) return
    inflight.get(oldest)?.release()
    inflight.delete(oldest)
  }

  /** Let the next continuation of this list go, once this call has written its cursor. */
  function settlePage(key: string, callID: string) {
    const running = inflight.get(key)
    if (running?.callID !== callID) return
    running.release()
    inflight.delete(key)
  }

  /** Drop one list's cursor, so a continuation can only follow a page this process actually served. */
  function forget(sessionID: string, kind: ListKind) {
    const state = paging.get(sessionID)
    if (!state) return
    remember(sessionID, { ...state, [kind]: undefined })
  }

  return {
    "tool.definition": async (input, output) => {
      const projected = projectJolliToolDefinition(input.toolID, output.description, output.parameters)
      output.parameters = projected.parameters
      output.description = projected.description
    },
    "tool.execute.before": async (input, output) => {
      const course = COURSE_TOOL_IDS.has(input.tool)
      const kind = kindOf(input.tool)
      if (!course && !kind) return
      if (!isRecord(output.args)) {
        if (course) throw new Error("Course tool arguments must be an object.")
        return
      }
      const args = output.args
      if (course) {
        const binding = await bindingOf(input.sessionID)
        if (!binding) throw new Error("Course tool requires a valid session course and assistant binding.")
        // The MCP executor retains this object, so the session binding replaces model-supplied ids.
        Object.assign(args, binding)
      }
      if (!kind) return
      const wantsMore = args.continue === true
      delete args.continue
      delete args[kind === "materials" ? "afterId" : "cursor"]
      // A fresh list starts over, and a failure of it must not leave the previous list's cursor behind.
      if (!wantsMore) return forget(input.sessionID, kind)
      const key = pageKey(input.sessionID, kind)
      await afterEarlierPage(key)
      const state = paging.get(input.sessionID)
      if (kind === "materials") {
        const page = state?.materials
        if (!page || page.courseId !== args.courseId || page.assistantId !== args.assistantId) {
          throw new Error("No course material page is saved for this session. Start a fresh list.")
        }
        if (page.nextCursor === null) throw new Error("No more course materials are available in this session.")
        args.afterId = page.nextCursor
        return claimPage(key, input.callID)
      }
      const cursor = state?.attachments?.nextCursor
      if (cursor === undefined) throw new Error("No attachment page is saved for this session. Start a fresh list.")
      if (cursor === null) throw new Error("No more attachments are available in this session.")
      args.cursor = cursor
      claimPage(key, input.callID)
    },
    "tool.execute.after": async (input, output) => {
      /**
       * ⚠ READ HERE, FROM THE WHOLE RESULT, BECAUSE THE STORED OUTPUT MAY BE CUT. The output limit
       * applies after this hook, and a cut JSON cannot be read back when the turn's sources are
       * judged; the evidence recorded on the tool part is what that judgement reads instead.
       *
       * ⚠ NOT RECORDED WHERE THE COURSE HIDES CITATIONS. Nothing judges a turn's sources then
       * (`SessionPrompt` asks for them only when the course shows citations), so the evidence — up to
       * one evidence limit per passage, synced to every client with the part — would be stored for
       * nobody. A course whose switch cannot be read records it, since the turn may still be judged.
       * A teacher who turns citations on mid-turn gets sources for that turn only from the reads
       * after the switch, and in full from the next turn.
       */
      const evidence = JolliSources.materialEvidenceOf(input.tool, output)
      if (evidence.length > 0 && (await citationsShown(input.sessionID)) !== false) {
        output.metadata = { ...(isRecord(output.metadata) ? output.metadata : {}), evidence }
      }
      if (JolliSources.isCourseTool(input.tool)) {
        await options.bridge.promise(
          Effect.logInfo("jolli course tool", {
            "session.id": input.sessionID,
            tool: input.tool,
            failed: "isError" in output && output.isError === true,
            evidence:
              evidence
                .map((item) => (item.kind === "material" ? `${item.materialId}:${item.title}` : item.url))
                .join(" | ") || "none",
          }),
        )
      }
      const kind = kindOf(input.tool)
      if (!kind) return
      // Released after the cursor below is written, so a waiting continuation reads the new one.
      const release = () => settlePage(pageKey(input.sessionID, kind), input.callID)
      const page = pageOf(output)
      const next = page?.hasMore ? page.nextCursor : null
      if (kind === "materials") {
        const courseId = input.args.courseId
        const assistantId = input.args.assistantId
        if (
          !page ||
          typeof courseId !== "number" ||
          typeof assistantId !== "number" ||
          (next !== null && (typeof next !== "number" || next <= 0))
        ) {
          forget(input.sessionID, kind)
          return release()
        }
        remember(input.sessionID, {
          ...paging.get(input.sessionID),
          materials: { nextCursor: next, courseId, assistantId },
        })
        return release()
      }
      if (!page || (next !== null && (typeof next !== "string" || next.length === 0))) {
        forget(input.sessionID, kind)
        return release()
      }
      remember(input.sessionID, {
        ...paging.get(input.sessionID),
        attachments: { nextCursor: next },
      })
      release()
    },
  }
}

/** The page a successful list call returned, or undefined for an error or an unexpected shape. */
function pageOf(output: unknown) {
  const text = JolliSources.firstText(output)
  return text === undefined ? undefined : Option.getOrUndefined(decodePage(text))
}

/**
 * Whether the course a session is bound to shows citations, as the student's catalogue states it, or
 * undefined when that cannot be read: an unbound session, no credential, no catalogue. Never fails.
 * The same reading `SessionPrompt` makes before it asks for a turn's sources.
 */
function citationsShownFor(bridge: EffectBridge.Shape, sessionID: string): Promise<boolean | undefined> {
  return bridge.promise(
    Effect.gen(function* () {
      const session = yield* (yield* Session.Service).get(SessionID.make(sessionID))
      const binding = courseBindingOf(session)
      if (!binding) return undefined
      const jolli = yield* JolliSession.Service
      const request = yield* jolli.request().pipe(
        Effect.timeout("5 seconds"),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      return (yield* JolliCourseGuardrails.resolve({ request, binding }))?.showCitations
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
  )
}

function pageKey(sessionID: string, kind: ListKind) {
  return `${sessionID}:${kind}`
}
