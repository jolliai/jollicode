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
 * student a fresh first page rather than a wrong one.
 */
import { courseBindingOf } from "@opencode-ai/core/jolli/binding"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Effect, Option, Schema } from "effect"
import type { EffectBridge } from "@/effect/bridge"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { isRecord } from "@/util/record"
import { COURSE_TOOL_IDS, kindOf, projectJolliToolDefinition, type ListKind } from "./jolli-mcp-tools"

type PagingState = {
  lastList?: ListKind
  materials?: { nextCursor: number | null; courseId: number; assistantId: number }
  attachments?: { nextCursor: string | null }
}

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
  options: { bridge: EffectBridge.Shape },
): Promise<Hooks> {
  const paging = new Map<string, PagingState>()

  async function bindingOf(sessionID: string) {
    const session = await options.bridge
      .promise(
        Effect.gen(function* () {
          const service = yield* Session.Service
          return yield* service.get(SessionID.make(sessionID))
        }),
      )
      .catch(() => undefined)
    const binding = courseBindingOf(session)
    const courseId = binding ? toPositiveInt(binding.courseId) : undefined
    const assistantId = binding ? toPositiveInt(binding.assistantId) : undefined
    if (courseId === undefined || assistantId === undefined) return undefined
    return { courseId, assistantId }
  }

  /** Drop one list's cursor, so a continuation can only follow a page this process actually served. */
  function forget(sessionID: string, kind: ListKind) {
    const state = paging.get(sessionID)
    if (!state) return
    paging.set(sessionID, {
      ...state,
      [kind]: undefined,
      lastList: state.lastList === kind ? undefined : state.lastList,
    })
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = paging.get(input.sessionID)
      if (!state?.lastList) return
      const next = state.lastList === "materials" ? state.materials?.nextCursor : state.attachments?.nextCursor
      output.system.push(
        `The most recently listed Jolliedu collection was ${state.lastList}. ` +
          (next === null
            ? "It has no further page. If the student asks for more, explain that the list is complete."
            : "If the student asks for more of that list, call its list tool with continue=true. The client supplies the saved cursor. " +
              "For a fresh list request, omit continue so the first page is shown. ") +
          "When a list result has hasMore=true, naturally tell the student in the language of their question " +
          "that more entries are available and how to ask to continue. Do not claim the list is complete.",
      )
    },
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
      const state = paging.get(input.sessionID)
      if (kind === "materials") {
        const page = state?.materials
        if (!page || page.courseId !== args.courseId || page.assistantId !== args.assistantId) {
          throw new Error("No course material page is saved for this session. Start a fresh list.")
        }
        if (page.nextCursor === null) throw new Error("No more course materials are available in this session.")
        args.afterId = page.nextCursor
        return
      }
      const cursor = state?.attachments?.nextCursor
      if (cursor === undefined) throw new Error("No attachment page is saved for this session. Start a fresh list.")
      if (cursor === null) throw new Error("No more attachments are available in this session.")
      args.cursor = cursor
    },
    "tool.execute.after": async (input, output) => {
      const kind = kindOf(input.tool)
      if (!kind) return
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
        )
          return forget(input.sessionID, kind)
        paging.set(input.sessionID, {
          ...paging.get(input.sessionID),
          lastList: kind,
          materials: { nextCursor: next, courseId, assistantId },
        })
        return
      }
      if (!page || (next !== null && (typeof next !== "string" || next.length === 0)))
        return forget(input.sessionID, kind)
      paging.set(input.sessionID, {
        ...paging.get(input.sessionID),
        lastList: kind,
        attachments: { nextCursor: next },
      })
    },
  }
}

/** The page a successful list call returned, or undefined for an error or an unexpected shape. */
function pageOf(output: unknown) {
  if (!isRecord(output) || output.isError === true || !Array.isArray(output.content)) return undefined
  const text = output.content.find(
    (item): item is { type: "text"; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  )?.text
  return text === undefined ? undefined : Option.getOrUndefined(decodePage(text))
}

/**
 * Metadata values are string-typed, but the Jolliedu tool schema takes numeric
 * ids. Silently coerce, and treat anything that is not a positive integer as
 * "no binding" so a malformed row cannot make the args worse than leaving them.
 */
function toPositiveInt(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
