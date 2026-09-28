import { isRecord } from "@/util/record"

/** Course tools whose server-owned binding is supplied from the Jollicode session. */
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

export function kindOf(tool: string): ListKind | undefined {
  if (tool === MATERIAL_LIST_TOOL) return "materials"
  if (tool === ATTACHMENT_LIST_TOOL) return "attachments"
  return undefined
}

/** Hide binding fields from both ordinary MCP tools and the code-mode catalog. */
function withoutBindingParameters(parameters: unknown): unknown {
  if (!isRecord(parameters)) return parameters
  const properties = isRecord(parameters.properties)
    ? Object.fromEntries(Object.entries(parameters.properties).filter(([name]) => !BINDING_PARAMETER_NAMES.has(name)))
    : parameters.properties
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((name) => typeof name !== "string" || !BINDING_PARAMETER_NAMES.has(name))
    : parameters.required
  return { ...parameters, properties, required }
}

function listParameters(parameters: unknown, cursor: "afterId" | "cursor"): unknown {
  if (!isRecord(parameters) || !isRecord(parameters.properties)) return parameters
  return {
    ...parameters,
    properties: {
      ...Object.fromEntries(Object.entries(parameters.properties).filter(([name]) => name !== cursor)),
      continue: {
        type: "boolean",
        description:
          "Set true only when the student asks for the next page of this list. The client supplies the saved cursor.",
      },
    },
    required: Array.isArray(parameters.required)
      ? parameters.required.filter((name) => name !== cursor)
      : parameters.required,
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
        ? "List the material catalog visible to the assistant in the bound course, without material body text. Use when the student asks which course materials are available; use search_remote_course_materials for a topic-specific question. For a fresh list omit `continue`; if the student asks for the next page, set `continue=true`. When `hasMore=true`, say more materials are available without implying the list is complete. The client supplies the course binding and saved pagination cursor; do not invent or pass either."
        : "List the student's available uploads across sessions, newest first, without reading their contents. Use when the student asks which files they uploaded; use search_user_attachments for questions about file contents. `textState=ready` means text can be read; supported images may be viewable through read_user_attachment. For a fresh list omit `continue`; if the student asks for the next page, set `continue=true`. When `hasMore=true`, say more files are available without implying the list is complete. The client supplies the saved pagination cursor; do not invent or pass it.",
    parameters: listParameters(withoutBinding, kind === "materials" ? "afterId" : "cursor"),
  }
}
