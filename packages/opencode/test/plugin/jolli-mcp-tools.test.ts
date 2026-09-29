import { describe, expect, test } from "bun:test"
import { Permission } from "@/permission"
import { COURSE_TOOL_IDS, courseToolBindingOf, unboundCourseToolRules } from "@/plugin/jolli-mcp-tools"

const BOUND = { metadata: { jolli: { courseId: "7", assistantId: "12" } } }

describe("plugin.jolli-mcp-tools", () => {
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
