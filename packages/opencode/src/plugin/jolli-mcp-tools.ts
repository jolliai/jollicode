import { courseBindingOf, type SessionLike } from "@opencode-ai/core/jolli/binding"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
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
export const COURSE_TOOL_IDS = new Set([
  "jolliedu_get_conversation_context",
  "jolliedu_list_all_materials_in_remote_course",
  "jolliedu_search_remote_course_materials",
  "jolliedu_get_remote_material_content",
])

const MATERIAL_LIST_TOOL = "jolliedu_list_all_materials_in_remote_course"
const ATTACHMENT_LIST_TOOL = "jolliedu_list_user_attachments"
const BINDING_PARAMETER_NAMES = new Set(["courseId", "assistantId"])

export type ListKind = "materials" | "attachments"

/**
 * The session's course binding as the course tools take it, or undefined when it has none usable.
 *
 * Metadata values are string-typed, but the Jolliedu tool schema takes numeric ids. Anything that
 * is not a positive integer reads as "no binding", so a malformed row cannot make the arguments
 * worse than leaving them out.
 */
export function courseToolBindingOf(session: SessionLike | undefined) {
  const binding = courseBindingOf(session)
  const courseId = binding ? toPositiveInt(binding.courseId) : undefined
  const assistantId = binding ? toPositiveInt(binding.assistantId) : undefined
  if (courseId === undefined || assistantId === undefined) return undefined
  return { courseId, assistantId }
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

export function kindOf(tool: string): ListKind | undefined {
  if (tool === MATERIAL_LIST_TOOL) return "materials"
  if (tool === ATTACHMENT_LIST_TOOL) return "attachments"
  return undefined
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
 * ⚠ `continue` IS DECLARED EVEN WHEN THE SCHEMA HAS NO `properties`. The description tells the
 * model to pass it, and a schema that closes `additionalProperties` would refuse an undeclared
 * field, leaving the model no way to reach the next page.
 */
function listParameters(parameters: unknown, cursor: "afterId" | "cursor"): unknown {
  if (!isRecord(parameters)) return parameters
  const properties = isRecord(parameters.properties) ? parameters.properties : {}
  return {
    ...parameters,
    properties: {
      ...Object.fromEntries(Object.entries(properties).filter(([name]) => name !== cursor)),
      continue: {
        type: "boolean",
        description:
          "Set true only when the student asks for the next page of this list. The client supplies the saved cursor.",
      },
    },
    ...(Array.isArray(parameters.required) && { required: parameters.required.filter((name) => name !== cursor) }),
  }
}

/** The model-facing definition of a Jolliedu tool, which the `tool.definition` hook applies in both catalogs. */
export function projectJolliToolDefinition(tool: string, description: string, parameters: unknown) {
  const withoutBinding = COURSE_TOOL_IDS.has(tool) ? withoutBindingParameters(parameters) : parameters
  const kind = kindOf(tool)
  if (!kind) return { description, parameters: withoutBinding }
  return {
    description:
      kind === "materials"
        ? "List the material catalog visible to the assistant in the bound course, without material body text. Use when the student asks which course materials are available; use search_remote_course_materials for a topic-specific question. For a fresh list omit `continue`; if the student asks for the next page, set `continue=true`. When `hasMore=true`, tell the student in their language that more materials are available and that they can ask for the next page; when it is false, the list is complete. The client supplies the course binding and saved pagination cursor; do not invent or pass either."
        : "List the student's available uploads across sessions, newest first, without reading their contents. Use when the student asks which files they uploaded; use search_user_attachments for questions about file contents. `textState=ready` means text can be read; supported images may be viewable through read_user_attachment. For a fresh list omit `continue`; if the student asks for the next page, set `continue=true`. When `hasMore=true`, tell the student in their language that more files are available and that they can ask for the next page; when it is false, the list is complete. The client supplies the saved pagination cursor; do not invent or pass it.",
    parameters: listParameters(withoutBinding, kind === "materials" ? "afterId" : "cursor"),
  }
}

function toPositiveInt(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
