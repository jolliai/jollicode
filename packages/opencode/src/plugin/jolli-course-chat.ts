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
 * ⚠ A LIST'S NEXT PAGE IS ASKED FOR WITH THE SERVER'S OWN CURSOR, WHICH THE MODEL PASSES BACK. Every
 * course list returns where its next page starts — a page number, or an opaque cursor that carries the
 * whole listing it continues — and its cursor parameter goes to the model as the server declared it.
 * The client accepts only cursors returned for the same session, tool and listing. This guards older
 * servers that accept arbitrary page numbers. Opaque material cursors carry their own catalog and level,
 * which the server validates, so those filters may be omitted on a continuation as its schema directs.
 * After a restart or eviction, a continuation must start again from the first page.
 *
 * ⚠ PAGING GUIDANCE LIVES IN THE TOOL DEFINITION AND THE RESULT, NEVER IN THE SYSTEM PROMPT. The
 * system block leads the cached prompt prefix, so a sentence there that follows the paging state
 * invalidated the cache for the whole history whenever a list was shown or ran out, and it rode
 * along on every request of the session, title generation included. The cursor parameter's own
 * description says how to pass it, and each page's own `hasMore` says whether there is more.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import { JolliClosedAssistants } from "@opencode-ai/core/jolli/closed-assistants"
import { JolliCourseGuardrails } from "@opencode-ai/core/jolli/course-guardrails"
import { refusalCodeOf } from "@opencode-ai/core/jolli/refusal"
import { bindingOrg } from "@opencode-ai/core/jolli/org-scoped-id"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Effect, Option, Schema } from "effect"
import type { EffectBridge } from "@/effect/bridge"
import { MCP } from "@/mcp"
import { JolliMcpCall } from "@/mcp/jolli-call"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { isRecord } from "@/util/record"
import { COURSE_TOOL_IDS, LIST_TOOL_IDS, courseToolBindingOf, projectJolliToolDefinition } from "./jolli-mcp-tools"

/**
 * Session keys whose cached values, in-flight reads or failure cooldowns are tracked. A long-lived
 * desktop sidecar would otherwise keep them for every session forever.
 */
const MAX_KEPT_SESSIONS = 256

/**
 * How long a session's citations switch is kept once read.
 *
 * ⚠ READ ONCE A MINUTE, NOT ONCE PER MATERIAL. The reading waits on the credential and then on the
 * catalogue, up to five seconds each. A turn reads materials one after another, so this cache avoids
 * repeating that work per result. It gates evidence collection only; final attribution reads the
 * catalogue switch again independently.
 */
const CITATIONS_TTL_MS = 60_000

/** Failed reads retry after a short cooldown instead of contacting a failing server on every step. */
const FAILED_READ_RETRY_MS = 10_000

/** A short default for the definition lookup; an explicit server timeout takes precedence. */
const MEMBER_DEFINITION_TIMEOUT_MS = 5_000

/** The member tool as the server describes it for a session's current asker. */
type MemberDefinition = { description: string; parameters: Record<string, unknown> }

/** The member tool a session is offered while the server has given it no definition: no roster parameters. */
const SUMMARY_MEMBER_DEFINITION: MemberDefinition = {
  description: "Read this course's instructor list and enrolled student count.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
}

const decodeMemberDefinition = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ description: Schema.String, parameters: Schema.Record(Schema.String, Schema.Unknown) }),
  ),
)

const MAX_PAGED_LISTS = 256
const MAX_PAGE_CURSORS = 64
const CURSOR_PARAMETERS = new Set(["page", "afterId", "cursor"])
const decodePage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      hasMore: Schema.Boolean,
      nextPage: Schema.optional(Schema.NullOr(Schema.Int)),
      nextCursor: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Int]))),
    }),
  ),
)

export async function JolliCourseChatPlugin(
  _input: PluginInput,
  options: {
    bridge: EffectBridge.Shape
    /** The member tool's definition for the session's asker; see {@link courseMemberDefinitionFor}. Replaced in tests. */
    memberDefinition?: (sessionID: string) => Promise<MemberDefinition | undefined>
    /** Whether the session's course shows citations; see {@link citationsShownFor}. Replaced in tests. */
    citationsShown?: (sessionID: string) => Promise<boolean | undefined>
    /** The signed-in account; see {@link signedInAccountOf}. Replaced in tests. */
    account?: () => Promise<SignedInAccount>
  },
): Promise<Hooks> {
  const pages = new Map<string, Set<string | number>>()
  // Prefetch in the before hook, then await an expired switch before recording evidence.
  const citations = keptReads<boolean | undefined>(CITATIONS_TTL_MS)
  /**
   * One authorization snapshot per user turn, shared by model steps and code-mode execution. A new user
   * message checks the role again; actual member calls still authorize on the server every time. A failed
   * read pins the summary for that turn too, so recovery cannot change a script's schema after it was shown.
   * Callers without a turn ID share only overlapping reads and the failure cooldown.
   */
  const members = memberReads()
  const accountOf = options.account ?? (() => signedInAccountOf(options.bridge))

  /** Whether the session's course shows citations, read at most once per {@link CITATIONS_TTL_MS}. */
  function citationsShown(sessionID: string) {
    return citations(sessionID, () =>
      (options.citationsShown ?? ((id: string) => citationsShownFor(options.bridge, id)))(sessionID),
    )
  }

  /** Account isolation also applies to in-flight reads and failure cooldowns. */
  async function memberDefinition(sessionID: string, turnID?: string) {
    const account = await accountOf()
    if (!account.ok) {
      members.forget(sessionID)
      return undefined
    }
    const definition = await members.read(sessionID, account.id, turnID, () =>
      (options.memberDefinition ?? ((id: string) => courseMemberDefinitionFor(options.bridge, id)))(sessionID),
    )
    // Signing out or changing accounts while the request runs invalidates its answer too.
    const current = await accountOf()
    if (current.ok && current.id === account.id) return definition
    members.forget(sessionID)
    return undefined
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

  return {
    /**
     * ⚠ A TURN REFUSED AS CLOSED IS REMEMBERED THE WAY A REFUSED START IS — see `closed-assistants.ts`.
     * An assistant that waits to be spoken to is offered by the same clock as one that speaks first,
     * so a student whose clock trails the gateway's would be handed it, and refused, on every new chat.
     */
    event: async ({ event }) => {
      if (event.type !== "session.error" || event.properties.error?.name !== "APIError") return
      const sessionID = event.properties.sessionID
      if (refusalCodeOf(event.properties.error.data.responseBody) !== "assistant_closed" || !sessionID) return
      const binding = await options.bridge.promise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          return courseBindingOf(yield* sessions.get(SessionID.make(sessionID)))
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
      )
      if (binding) JolliClosedAssistants.record(binding.assistantId)
    },
    "tool.definition": async (input, output) => {
      /**
       * ⚠ THE MEMBER TOOL'S LISTED SCHEMA IS REPLACED BY THE SERVER'S FOR THE SESSION'S ASKER. The listing
       * declares every view's parameters, which must not be exposed as the default. The
       * projection below still applies, so the binding fields stay hidden whatever the server sent.
       *
       * The first definition pass of a user turn waits for a role check. Prefetching on chat.message would run before
       * CourseServer.ensure can reconnect, and a background summary could make a teacher's first question
       * appear to lack roster support. The configured MCP timeout bounds the read, with a short default.
       *
       * ⚠ THE MEMBER TOOL BY NAME, NOT "ANY TOOL WHOSE SCHEMA DECLARES `describeOnly`". What such a tool is
       * offered while the server gives it no definition is its own (here, the summary), and its read finds it by
       * name; a second tool described per asker needs both for itself, so a general test now would only move this
       * name somewhere less visible.
       */
      if (input.toolID === JolliSources.MEMBERS_TOOL) {
        const definition =
          (input.sessionID && (await memberDefinition(input.sessionID, input.turnID))) || SUMMARY_MEMBER_DEFINITION
        output.description = definition.description
        output.parameters = structuredClone(definition.parameters)
      }
      const projected = projectJolliToolDefinition(input.toolID, output.description, output.parameters)
      output.parameters = projected.parameters
      output.description = projected.description
    },
    "tool.execute.before": async (input, output) => {
      const course = COURSE_TOOL_IDS.has(input.tool)
      if (!course && !LIST_TOOL_IDS.has(input.tool)) return
      if (!isRecord(output.args)) {
        if (course) throw new Error("Course tool arguments must be an object.")
        return
      }
      const args = output.args
      // This invocation's original schema; a concurrent relist cannot change what this call accepts.
      const properties =
        isRecord(input.parameters) && isRecord(input.parameters.properties) ? input.parameters.properties : {}
      if (course) {
        const binding = await bindingOf(input.sessionID)
        if (!binding) throw new Error("Course tool requires a valid session course and assistant binding.")
        // The MCP executor retains this object, so the session binding replaces model-supplied ids.
        Object.assign(args, binding)
        delete args.sessionId
        // Asks the member tool for its own definition instead of the members: the client's read alone sends it.
        delete args.describeOnly
        /**
         * ⚠ THE CALLING SESSION'S OWN ID, A SUBAGENT'S INCLUDED, NOT ITS TASK ROOT'S. The gateway records a
         * subagent's session with its parent, from `x-parent-session-id` on the subagent's model requests,
         * which come before any tool call it makes. The server walks from this id up to the task's root
         * itself (`taskSessionFor` in jolliedu), so the root's id is not substituted here.
         */
        if ("sessionId" in properties) args.sessionId = input.sessionID
      }
      if (LIST_TOOL_IDS.has(input.tool)) {
        const cursor =
          input.tool === JolliSources.ASSIGNMENT_LIST_TOOL
            ? "page"
            : (["cursor", "afterId"].find((name) => name in properties) ?? "cursor")
        for (const name of CURSOR_PARAMETERS) {
          if (name !== cursor || args[name] === null) delete args[name]
        }
        const value = args[cursor]
        /**
         * ⚠ ASSIGNMENT PAGES START AT 0, SO ONLY PAGE 0 NEEDS NO RETURNED CURSOR. The server declares `page`
         * as `.min(0)` and answers with `nextPage = page + 1`: the first page returns `nextPage: 1`, and
         * `page: 1` is the second page, accepted only once a page returned it, like any other.
         */
        if (value !== undefined && !(cursor === "page" && value === 0)) {
          const key = pageKey(input.sessionID, input.tool, args, value)
          const returned = pages.get(key)
          if ((typeof value !== "string" && typeof value !== "number") || !returned?.has(value)) {
            throw new Error(
              "Pagination cursor was not returned for this list. Omit the cursor to restart from the first page.",
            )
          }
          // A list being paged through is the most recently used, so it is not the one the bound drops.
          pages.delete(key)
          pages.set(key, returned)
        }
      }
      // Read while the call runs, so its result is not held back for it after; see the after hook.
      if (JolliSources.isMaterialTool(input.tool)) void citationsShown(input.sessionID)
    },
    "tool.execute.after": async (input, output) => {
      if (LIST_TOOL_IDS.has(input.tool)) {
        const text = JolliSources.firstText(output)
        const page = text === undefined ? Option.none() : decodePage(text)
        if (Option.isSome(page) && page.value.hasMore) {
          const next = input.tool === JolliSources.ASSIGNMENT_LIST_TOOL ? page.value.nextPage : page.value.nextCursor
          if (typeof next === "string" || typeof next === "number") {
            const key = pageKey(input.sessionID, input.tool, input.args, next)
            const returned = pages.get(key) ?? new Set<string | number>()
            returned.add(next)
            if (returned.size > MAX_PAGE_CURSORS) returned.delete(returned.values().next().value!)
            pages.delete(key)
            pages.set(key, returned)
            if (pages.size > MAX_PAGED_LISTS) pages.delete(pages.keys().next().value!)
          }
        }
      }
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
       *
       * ⚠ THE SWITCH WAS ASKED FOR BEFORE THE CALL WENT OUT. Asked only here, a read that missed the
       * cache held the result back from the model for as long as the credential and the catalogue
       * took, up to ten seconds with the backend slow; started in the before hook, it runs alongside
       * the call, and this waits only for what is left of it.
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
    },
  }
}

/**
 * The listing a cursor belongs to: the session, the tool and the filters it was called with. A filter set to
 * null names the same listing as one left out, so a page and its continuation key alike whichever way the
 * model wrote it. Only opaque material cursors carry catalog and level; older numeric cursors still need
 * both filters.
 */
function pageKey(sessionID: string, tool: string, args: Record<string, unknown>, cursor: unknown) {
  const positioned = tool === JolliSources.MATERIAL_LIST_TOOL && typeof cursor === "string"
  return JSON.stringify([
    sessionID,
    tool,
    Object.entries(args)
      .filter(
        ([name, value]) =>
          value !== null &&
          value !== undefined &&
          !CURSOR_PARAMETERS.has(name) &&
          name !== "sessionId" &&
          (!positioned || (name !== "catalog" && name !== "underMaterialId")),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  ])
}

/**
 * Whether the course a session is bound to shows citations, as the student's catalogue states it, or
 * undefined when that cannot be read: an unbound session, no credential, no catalogue. Never fails.
 * The same reading `SessionPrompt` makes before it asks for a turn's sources.
 */
function citationsShownFor(bridge: EffectBridge.Shape, sessionID: string): Promise<boolean | undefined> {
  return bridge.promise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const binding = courseBindingOf(yield* sessions.get(SessionID.make(sessionID)))
      if (!binding) return undefined
      return (yield* JolliCourseGuardrails.ofBinding(binding))?.showCitations
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
  )
}

/**
 * The member tool's definition as the server gives it for a session's current asker, or undefined when the session
 * has no binding, the server's member tool does not describe itself (a server older than `describeOnly`), or its
 * answer has an unsupported shape. Transport errors and server isError replies fail instead, allowing the
 * caller to apply the short failure cooldown rather than treating an outage as a valid definition.
 */
export function courseMemberDefinitionFor(
  bridge: EffectBridge.Shape,
  sessionID: string,
): Promise<MemberDefinition | undefined> {
  return bridge.promise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const mcp = yield* MCP.Service
      const session = yield* sessions.get(SessionID.make(sessionID))
      const binding = courseToolBindingOf(session)
      if (!binding) return undefined
      const entry = (yield* mcp.tools())[JolliSources.MEMBERS_TOOL]
      // Asked only once the tool is listed, so a list without it is a connection that dropped since, not an answer.
      if (!entry) return yield* Effect.fail(new Error("The course server lists no member tool just now"))
      const properties = entry.def.inputSchema.properties ?? {}
      // Asked without `describeOnly`, a server would answer with the members themselves.
      if (!("describeOnly" in properties)) {
        yield* Effect.logWarning(
          "jolli-course-chat: the member tool does not support describeOnly; using the summary",
          {
            sessionID,
          },
        )
        return undefined
      }
      // Made in the session's org, as every course call is: one connection serves every session.
      // The server publishes no outputSchema for this tool. Keep callTool's protocol validation;
      // if a server adds an output schema, describeOnly must be part of that server's output contract.
      const response = yield* Effect.tryPromise(() =>
        JolliMcpCall.run({ org: bindingOrg(session) }, () =>
          entry.client.callTool(
            {
              name: entry.def.name,
              arguments: { ...binding, ...("sessionId" in properties && { sessionId: sessionID }), describeOnly: true },
            },
            undefined,
            { timeout: entry.timeout ?? MEMBER_DEFINITION_TIMEOUT_MS },
          ),
        ),
      )
      /**
       * ⚠ AN `isError` RESULT IS A FAILED READ, NOT AN ANSWER. The course server reports a handler that threw — a
       * database error, a timeout of its own — as an `isError` result (`toCallToolResult` in jolliedu), so it says
       * nothing about the asker's view. The caller pins the summary for this turn and retries in a later turn
       * after {@link FAILED_READ_RETRY_MS}, without reusing a previous turn's privileged definition. A binding
       * the server refuses fails the same way; every course call of that session is refused anyway.
       */
      if (response.isError) {
        const reason = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ")
        return yield* Effect.fail(new Error(`The course server could not describe the member tool: ${reason}`))
      }
      const text = JolliSources.firstText(response)
      const definition = text === undefined ? undefined : Option.getOrUndefined(decodeMemberDefinition(text))
      if (!definition) {
        yield* Effect.logWarning("jolli-course-chat: unsupported member tool definition; using the summary", {
          sessionID,
        })
      }
      return definition
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("jolli-course-chat: could not read the member tool's definition", {
          sessionID,
          cause: String(cause),
        }),
      ),
    ),
  )
}

/** The signed-in account as {@link signedInAccountOf} reads it: `id` absent when signed out. */
type SignedInAccount = { readonly ok: true; readonly id?: string } | { readonly ok: false }

/**
 * The credential identity used by the catalogue cache (`cache_key`), stable across token refresh.
 * Not ok when the credential store cannot be read.
 */
function signedInAccountOf(bridge: EffectBridge.Shape): Promise<SignedInAccount> {
  return bridge.promise(
    Effect.gen(function* () {
      const jolli = yield* JolliSession.Service
      const row = yield* jolli.current()
      return row ? { ok: true as const, id: row.cache_key } : { ok: true as const }
    }).pipe(Effect.catchCause(() => Effect.succeed({ ok: false as const }))),
  )
}

/** Bounded TTL reads that await refresh and never return an expired value, including after failures. */
function keptReads<T>(ttl: number) {
  const entries = new Map<
    string,
    { kept?: { value: T; readAt: number }; reading?: Promise<T | undefined>; failedAt?: number }
  >()
  return async function (key: string, read: () => Promise<T>) {
    const entry = entries.get(key) ?? {}
    entries.delete(key)
    entries.set(key, entry)
    if (entries.size > MAX_KEPT_SESSIONS) entries.delete(entries.keys().next().value!)
    const now = Date.now()
    const stale = !entry.kept || now - entry.kept.readAt >= ttl
    if (!stale) return entry.kept?.value
    entry.kept = undefined
    const resting = entry.failedAt !== undefined && now - entry.failedAt < FAILED_READ_RETRY_MS
    if (!entry.reading && !resting) {
      entry.reading = read()
        .then(
          (value) => {
            entry.kept = { value, readAt: Date.now() }
            entry.failedAt = undefined
            return value
          },
          () => {
            entry.failedAt = Date.now()
            return undefined
          },
        )
        .finally(() => {
          entry.reading = undefined
        })
    }
    return entry.reading
  }
}

/** Keep only the latest turn for each account/session, including its fallback on a failed read. */
function memberReads() {
  type Read = {
    accountID?: string
    turnID?: string
    reading: Promise<MemberDefinition | undefined>
    settled: boolean
    failedAt?: number
  }
  const entries = new Map<string, Read>()
  function readFor(
    key: string,
    accountID: string | undefined,
    turnID: string | undefined,
    read: () => Promise<MemberDefinition | undefined>,
  ) {
    const previous = entries.get(key)
    if (
      previous &&
      previous.accountID === accountID &&
      previous.turnID === turnID &&
      (turnID !== undefined || !previous.settled)
    ) {
      entries.delete(key)
      entries.set(key, previous)
      return previous.reading
    }
    const resting =
      previous?.accountID === accountID &&
      previous?.failedAt !== undefined &&
      Date.now() - previous.failedAt < FAILED_READ_RETRY_MS
    const entry: Read = {
      accountID,
      turnID,
      settled: false,
      failedAt: resting ? previous.failedAt : undefined,
      reading: Promise.resolve(undefined),
    }
    entry.reading = (resting ? Promise.resolve(undefined) : read())
      .catch(() => {
        entry.failedAt = Date.now()
        return undefined
      })
      .finally(() => {
        entry.settled = true
      })
    entries.delete(key)
    entries.set(key, entry)
    if (entries.size > MAX_KEPT_SESSIONS) entries.delete(entries.keys().next().value!)
    return entry.reading
  }
  return { read: readFor, forget: (key: string) => entries.delete(key) }
}
