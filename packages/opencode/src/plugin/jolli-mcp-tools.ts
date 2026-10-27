import { inTaskSession } from "@opencode-ai/core/jolli/assignment"
import { courseBindingOf, type SessionLike } from "@opencode-ai/core/jolli/binding"
import { JOLLI_MCP_SERVER } from "@opencode-ai/core/jolli/mcp"
import { parseCourseBinding } from "@opencode-ai/core/jolli/org-scoped-id"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect } from "effect"
import type { MCP } from "@/mcp"
import { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import { isRecord } from "@/util/record"

/**
 * Course tools whose server-owned binding is supplied from the Jollicode session.
 *
 * ⚠ MATCHED ON THE COMBINED KEY, WHICH ANOTHER SERVER COULD ALSO PRODUCE. Keys are
 * `sanitize(server) + "_" + sanitize(tool)`, so a server a project names `jolliedu_get` offering
 * `conversation_context` lands on the same key, and the hooks cannot tell the two apart: they are
 * handed the key, not the server. Accepted rather than guarded, because what such a server would
 * receive is the session's course and assistant ids — two numeric identifiers, no secret — and never
 * the credential, which the MCP layer attaches by destination origin, not by server name.
 * Guarding it would mean threading the server name through upstream's generic hook inputs.
 */
export const COURSE_TOOL_IDS = new Set<string>(JolliSources.COURSE_TOOLS)

export const LIST_TOOL_IDS = new Set([
  JolliSources.ASSIGNMENT_LIST_TOOL,
  JolliSources.MATERIAL_LIST_TOOL,
  `${JolliSources.COURSE_TOOL_PREFIX}list_user_attachments`,
])

/**
 * The parameters the client fills from the session: the course binding, and the session's own id where a tool
 * takes one, which tells the server which assignment task, if any, the call is made in. `describeOnly` is the
 * member tool's registration read, which the client alone makes.
 */
const BINDING_PARAMETER_NAMES = new Set(["courseId", "assistantId", "sessionId", "describeOnly"])

/**
 * The session's course binding as the course tools take it, or undefined when it has none usable.
 *
 * Metadata values are org-scoped id strings, but the Jolliedu tool schema takes numeric ids — the org
 * travels as the call's scope, not as an argument. Anything that does not parse reads as "no
 * binding", so a malformed row cannot make the arguments worse than leaving them out.
 */
export function courseToolBindingOf(session: SessionLike | undefined) {
  const ids = parseCourseBinding(courseBindingOf(session))
  return ids && { courseId: ids.courseId, assistantId: ids.assistantId }
}

/**
 * Rules that withhold the course tools from a session with no usable course binding.
 *
 * ⚠ A RULESET, SO EVERY CATALOG HIDES THEM THE SAME WAY. The ordinary tool list and the code-mode
 * catalog both filter MCP tools through the session's ruleset, so one set of deny rules keeps an
 * unbound session from being offered tools whose every call would be refused for the missing
 * binding — a wasted turn each time the model tried one.
 */
export function unboundCourseToolRules(session: SessionLike | undefined): PermissionV1.Rule[] {
  if (courseToolBindingOf(session)) return []
  return [...COURSE_TOOL_IDS].map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
}

/**
 * The same assignment switch, and whether the session works on an assignment task, control ordinary MCP tools
 * and the code-mode catalog (`JolliSources.withheldCourseTools`).
 */
export function courseToolRules(
  session: SessionLike | undefined,
  includeAssignments: boolean,
  taskSession: boolean,
): PermissionV1.Rule[] {
  return JolliSources.withheldCourseTools({
    bound: courseToolBindingOf(session) !== undefined,
    includeAssignments,
    taskSession,
  }).map((permission) => ({ permission, pattern: "*", action: "deny" as const }))
}

/**
 * The connected MCP servers' tools, for a session withheld the given course tools. The one read of them
 * both the ordinary tool list and the code-mode catalog take.
 *
 * ⚠ LISTED AGAIN WHEN THE MANIFEST LACKS A COURSE TOOL THE SESSION IS OFFERED. An institution can turn
 * assignments on, or a deployment add a tool, after the Jolli connection cached its manifest, and the
 * server does not announce the change, so that manifest would hide the tool for as long as the
 * connection lives. The MCP layer lists it again at most once a minute and in the background, so a
 * server that never comes to offer the tool neither is asked on every step nor holds a step up; the
 * step that asks goes on with the manifest it has, and a later one reads the new manifest.
 */
export const listMcpTools = Effect.fn("JolliMcpTools.listMcpTools")(function* (
  mcp: MCP.Interface,
  withheld: ReadonlySet<string>,
) {
  const listed = yield* mcp.tools()
  if (JolliSources.COURSE_TOOLS.every((tool) => withheld.has(tool) || tool in listed)) return listed
  yield* mcp.relist(JOLLI_MCP_SERVER)
  return listed
})

/**
 * Whether a session works on an assignment task, read through the v1 session store: the ordinary tool
 * list and the code-mode catalog both ask. A parent the store no longer has reads as no task, as
 * {@link inTaskSession} requires of its reader.
 */
export function inStoredTaskSession(sessions: Session.Interface, session: Session.Info) {
  return inTaskSession(session, (id) =>
    sessions.get(SessionID.make(id)).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined))),
  )
}

/**
 * Hide binding fields from both ordinary MCP tools and the code-mode catalog. A key the schema did
 * not have stays absent rather than being written out as `undefined`.
 */
function withoutBindingParameters(parameters: unknown): unknown {
  if (!isRecord(parameters)) return parameters
  return {
    ...parameters,
    ...(isRecord(parameters.properties) && {
      properties: Object.fromEntries(
        Object.entries(parameters.properties).filter(([name]) => !BINDING_PARAMETER_NAMES.has(name)),
      ),
    }),
    ...(Array.isArray(parameters.required) && {
      required: parameters.required.filter((name) => typeof name !== "string" || !BINDING_PARAMETER_NAMES.has(name)),
    }),
  }
}

/**
 * The model-facing definition of a Jolliedu tool, which the `tool.definition` hook applies in both catalogs.
 *
 * Preserve the server's description and cursor schema, including older deployments. Add the paging
 * invariant locally so complete-list requests do not depend on a server rollout for that guidance.
 */
export function projectJolliToolDefinition(tool: string, description: string, parameters: unknown) {
  return {
    description: LIST_TOOL_IDS.has(tool)
      ? `${description}\nWhen hasMore is true, this is only a partial list. For a complete list, follow every page until hasMore is false. Pass only the nextPage or nextCursor returned by this same list with the same filters; never invent a page number or cursor. If you stop early, tell the student that more results remain.`
      : description,
    parameters: COURSE_TOOL_IDS.has(tool) ? withoutBindingParameters(parameters) : parameters,
  }
}
