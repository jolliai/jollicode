import { describe, expect, test } from "bun:test"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Effect } from "effect"
import type { MCP } from "@/mcp"
import { Permission } from "@/permission"
import {
  COURSE_TOOL_IDS,
  courseToolBindingOf,
  courseToolRules,
  listMcpTools,
  unboundCourseToolRules,
  projectJolliToolDefinition,
} from "@/plugin/jolli-mcp-tools"

const BOUND = { id: "ses_a", metadata: { jolli: { courseId: "7", assistantId: "12" } } }
/** A session an assignment task started, bound to the task's course and agent. */
const TASK = {
  ...BOUND,
  metadata: { ...BOUND.metadata, jolliTask: { sessionID: "ses_a", assignmentId: "40", partId: "42" } },
}

describe("plugin.jolli-mcp-tools", () => {
  test("hides the member tool's binding and registration-only fields from the model", () => {
    const projected = projectJolliToolDefinition(JolliSources.MEMBERS_TOOL, "Members", {
      type: "object",
      properties: { courseId: {}, assistantId: {}, sessionId: {}, describeOnly: {}, query: {} },
      required: ["courseId", "assistantId"],
    })
    expect(projected.parameters).toMatchObject({ properties: { query: {} }, required: [] })
    expect(COURSE_TOOL_IDS.has("jolliedu_get_course_members")).toBe(true)
  })

  test("binds assignment tools to the session and hides binding ids from the model", () => {
    const tool = "jolliedu_list_remote_course_assignments"
    expect(COURSE_TOOL_IDS.has(tool)).toBe(true)
    expect(
      projectJolliToolDefinition(tool, "Assignments", {
        type: "object",
        properties: { courseId: { type: "number" }, assistantId: { type: "number" }, page: { type: "integer" } },
        required: ["courseId", "assistantId"],
      }).parameters,
    ).toEqual({ type: "object", properties: { page: { type: "integer" } }, required: [] })
  })
  /**
   * The server writes how to reach a list's next page on the cursor parameter, and the model passes back the
   * cursor a page returned, as on the web: the client retains the description and adds paging invariants.
   */
  test("passes every list tool's description and cursor parameter through as the server wrote them", () => {
    const lists = {
      jolliedu_list_remote_course_assignments: "page",
      jolliedu_list_all_materials_in_remote_course: "cursor",
      jolliedu_list_user_attachments: "cursor",
    } as const
    for (const [tool, cursor] of Object.entries(lists)) {
      const description = `The server's own description of ${tool}, with what each field means.`
      const properties = {
        [cursor]: { type: "string", description: "To read the next page, pass the previous page's cursor." },
        assignmentId: { type: "number", description: "One assignment alone." },
      }
      const projected = projectJolliToolDefinition(tool, description, { type: "object", properties })
      expect(projected.description).toStartWith(description)
      expect(projected.description).toContain("hasMore is true")
      expect(projected.description).toContain("follow every page")
      expect(projected.description).toContain("never invent")
      expect(projected.parameters).toEqual({ type: "object", properties })
    }
  })
  test("hides the session id a session-aware course tool takes, which the client fills in", () => {
    const parameters = {
      type: "object",
      properties: { courseId: { type: "number" }, sessionId: { type: "string" }, number: { type: "number" } },
      required: ["courseId", "number"],
    }
    expect(projectJolliToolDefinition("jolliedu_read_student_work", "Read", parameters).parameters).toEqual({
      type: "object",
      properties: { number: { type: "number" } },
      required: ["number"],
    })
  })

  test("offers a task session the work its task uses, and any other course session the student's own work", () => {
    const catalog = Object.fromEntries(
      ["jolliedu_list_student_work", "jolliedu_search_student_work", "jolliedu_read_student_work"].map((name) => [
        name,
        name,
      ]),
    )
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(TASK, false, true)))).toEqual([
      "jolliedu_search_student_work",
      "jolliedu_read_student_work",
    ])
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(BOUND, true, false)))).toEqual(
      Object.keys(catalog),
    )
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(BOUND, false, false)))).toEqual([])
  })

  test("withholds assignment listing from both catalogs when the bound assistant excludes assignments", () => {
    const tool = "jolliedu_list_remote_course_assignments"
    const catalog = { [tool]: tool, jolliedu_search_remote_course_materials: "search", github_list_issues: "issues" }
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(BOUND, false, false)))).toEqual([
      "jolliedu_search_remote_course_materials",
      "github_list_issues",
    ])
    expect(Object.keys(Permission.visibleTools(catalog, courseToolRules(BOUND, true, false)))).toContain(tool)
    expect(courseToolRules(undefined, true, false)).toEqual(unboundCourseToolRules(undefined))
  })

  test("reads a session's binding as the numeric ids the course tools take", () => {
    expect(courseToolBindingOf(BOUND)).toEqual({ courseId: 7, assistantId: 12 })
  })

  test("course tool arguments carry the numeric ids of an org-scoped binding", () => {
    expect(
      courseToolBindingOf({ metadata: { jolli: { courseId: "acme:main:12", assistantId: "acme:main:5" } } }),
    ).toEqual({ courseId: 12, assistantId: 5 })
    expect(
      courseToolBindingOf({ metadata: { jolli: { courseId: "acme:12", assistantId: "acme:main:5" } } }),
    ).toBeUndefined()
  })

  test("treats a course and assistant naming different orgs as no binding at all", () => {
    for (const [courseId, assistantId] of [
      ["acme:main:12", "acme:other:5"],
      ["acme:main:12", "5"],
      ["12", "beta:north:5"],
    ]) {
      const session = { metadata: { jolli: { courseId, assistantId } } }
      expect(courseToolBindingOf(session)).toBeUndefined()
      expect(unboundCourseToolRules(session)).toHaveLength(COURSE_TOOL_IDS.size)
    }
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

  /**
   * An institution can turn assignments on, or a deployment add a tool, after the connection cached its
   * manifest, and the server does not say so: a session offered a course tool its manifest lacks asks the
   * MCP layer to list the course server again. Nobody else does, and nobody asks again once the tool is there.
   * The listing runs in the background, so the step that asks goes on with the manifest it has.
   */
  test("lists the course server again only when the manifest lacks a course tool the session is offered", async () => {
    const gated = new Set<string>([
      JolliSources.ASSIGNMENT_LIST_TOOL,
      JolliSources.WORK_LIST_TOOL,
      ...JolliSources.WORK_TOOLS,
    ])
    const manifest = (tools: string[]) => Object.fromEntries(tools.map((tool) => [tool, {} as MCP.McpTool]))
    const older = manifest([...COURSE_TOOL_IDS].filter((tool) => !gated.has(tool)))
    const current = manifest([...COURSE_TOOL_IDS])
    const relisted: string[] = []
    const mcp = {
      tools: () => Effect.succeed(relisted.length === 0 ? older : current),
      relist: (server: string) =>
        Effect.sync(() => {
          relisted.push(server)
        }),
    } as unknown as MCP.Interface
    const withheld = (rules: { permission: string }[]) => new Set(rules.map((rule) => rule.permission))

    expect(await Effect.runPromise(listMcpTools(mcp, withheld(unboundCourseToolRules({ metadata: {} }))))).toBe(older)
    expect(await Effect.runPromise(listMcpTools(mcp, withheld(courseToolRules(BOUND, false, false))))).toBe(older)
    expect(relisted).toEqual([])
    // A task's session reads the task's work even where its assistant does not read assignments.
    expect(await Effect.runPromise(listMcpTools(mcp, withheld(courseToolRules(TASK, false, true))))).toBe(older)
    expect(relisted).toEqual(["jolliedu"])
    expect(await Effect.runPromise(listMcpTools(mcp, withheld(courseToolRules(BOUND, true, false))))).toBe(current)
    expect(relisted).toEqual(["jolliedu"])
  })
})
