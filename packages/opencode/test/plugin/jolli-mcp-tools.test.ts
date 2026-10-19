import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"
import {
  COURSE_TOOL_IDS,
  courseToolBindingOf,
  courseToolRules,
  unboundCourseToolRules,
  projectJolliToolDefinition,
} from "@/plugin/jolli-mcp-tools"

const BOUND = { metadata: { jolli: { courseId: "7", assistantId: "12" } } }

describe("plugin.jolli-mcp-tools", () => {
  test("binds assignment tools to the session and hides binding ids from the model", () => {
    const tool = "jolliedu_list_remote_course_assignments"
    expect(COURSE_TOOL_IDS.has(tool)).toBe(true)
    expect(
      projectJolliToolDefinition(tool, "Assignments", {
        type: "object",
        properties: { courseId: { type: "number" }, assistantId: { type: "number" } },
        required: ["courseId", "assistantId"],
      }).parameters,
    ).toEqual({ type: "object", properties: { continue: expect.objectContaining({ type: "boolean" }) }, required: [] })
  })
  test("withholds assignment listing from both catalogs when the bound assistant excludes assignments", () => {
    const tool = "jolliedu_list_remote_course_assignments"
    const catalog = { [tool]: tool, jolliedu_search_remote_course_materials: "search", github_list_issues: "issues" }
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(BOUND, false)))).toEqual([
      "jolliedu_search_remote_course_materials",
      "github_list_issues",
    ])
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(BOUND, true)))).toContain(tool)
    expect(courseToolRules(undefined, true)).toEqual(unboundCourseToolRules(undefined))
  })

  test("reads a session's binding as the numeric ids the course tools take", () => {
    expect(courseToolBindingOf(BOUND)).toEqual({ courseId: 7, assistantId: 12 })
  })

  test("treats a missing or malformed binding as no binding at all", () => {
    expect(courseToolBindingOf(undefined)).toBeUndefined()
    expect(courseToolBindingOf({ metadata: {} })).toBeUndefined()
    expect(courseToolBindingOf({ metadata: { jolli: { courseId: "0", assistantId: "12" } } })).toBeUndefined()
    expect(courseToolBindingOf({ metadata: { jolli: { courseId: "7", assistantId: "1.5" } } })).toBeUndefined()
  })

  test("withholds nothing from a bound session", () => {
    expect(unboundCourseToolRules(BOUND)).toEqual([])
  })

  test("withholds exactly the course tools from an unbound session, in every catalog that filters by ruleset", () => {
    const rules = unboundCourseToolRules({ metadata: {} })
    const catalog = Object.fromEntries(
      [...COURSE_TOOL_IDS, "jolliedu_list_user_attachments", "github_list_issues"].map((name) => [name, name]),
    )

    // The code-mode catalog hides MCP tools through this same helper.
    expect(Object.keys(Permission.visibleTools(catalog, rules))).toEqual([
      "jolliedu_list_user_attachments",
      "github_list_issues",
    ])
  })
})
