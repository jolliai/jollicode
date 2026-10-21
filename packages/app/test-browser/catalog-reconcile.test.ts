import { beforeEach, describe, expect, test } from "bun:test"
import { assistantsForCourse, courseById, enrolledCourses, resetCatalog, setCatalog, viewer } from "@/jolli/catalog"
import type { Assistant, Catalog, Course, Viewer } from "@/jolli/types"

const course = (id: string, over: Partial<Course> = {}): Course => ({
  id,
  code: `CS ${id}`,
  title: "A course",
  kind: "code",
  accent: 1,
  assistantIds: [],
  status: "published",
  entryState: "open",
  endsOn: null,
  ...over,
})

const assistant = (id: string, courseId: string, over: Partial<Assistant> = {}): Assistant => ({
  id,
  courseId,
  name: `Assistant ${id}`,
  kind: "code",
  icon: "Sparkles",
  blurb: "",
  accent: 1,
  instructions: "",
  allowedModelIds: [],
  guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
  coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
  skills: [],
  status: "live",
  ...over,
})

const catalog = (courses: Course[], assistants: Assistant[], who?: Viewer): Catalog => ({
  status: "ok",
  courses,
  assistants,
  modelTiers: {},
  ...(who ? { viewer: who } : {}),
})

beforeEach(() => resetCatalog())

/**
 * ⚠ A REFRESH MUST KEEP EACH COURSE AND ASSISTANT AS THE SAME OBJECT. The pickers' `For` rows are
 * keyed by it, and opening either picker starts a refresh: replaced, every row was rebuilt and the
 * keyboard highlight dropped. Here rather than beside the other catalogue tests because only the
 * browser build of a Solid store keeps object identity.
 */
describe("setCatalog", () => {
  test("keeps a course and an assistant that are still there as the same object, updated", () => {
    setCatalog(catalog([course("1", { assistantIds: ["a"] }), course("2")], [assistant("a", "1")]))
    const before = courseById("1")
    const helper = assistantsForCourse("1")[0]

    setCatalog(
      catalog(
        [course("0"), course("1", { assistantIds: ["a"], code: "CS 1b" }), course("2")],
        [assistant("a", "1", { name: "Renamed" })],
      ),
    )
    expect(courseById("1")).toBe(before)
    expect(courseById("1")?.code).toBe("CS 1b")
    expect(assistantsForCourse("1")[0]).toBe(helper)
    expect(assistantsForCourse("1")[0]?.name).toBe("Renamed")
    expect(enrolledCourses().map((item) => item.id)).toEqual(["0", "1", "2"])
  })

  test("drops a course and an assistant the answer no longer has", () => {
    setCatalog(
      catalog(
        [course("1", { assistantIds: ["a"] }), course("2", { assistantIds: ["b"] })],
        [assistant("a", "1"), assistant("b", "2")],
      ),
    )
    setCatalog(catalog([course("2", { assistantIds: ["b"] })], [assistant("b", "2")]))
    expect(enrolledCourses().map((item) => item.id)).toEqual(["2"])
    expect(courseById("1")).toBeUndefined()
    expect(assistantsForCourse("2").map((item) => item.id)).toEqual(["b"])
  })

  // The viewer rides along with the courses: replaced by each answer, not merged, and gone when one has none.
  test("takes the viewer from each answer", () => {
    setCatalog(catalog([course("1")], [], { name: "Ada", email: "ada@example.edu" }))
    expect(viewer()).toEqual({ name: "Ada", email: "ada@example.edu" })
    setCatalog(catalog([course("1")], [], { name: "Grace" }))
    expect(viewer()).toEqual({ name: "Grace" })
    setCatalog(catalog([course("1")], []))
    expect(viewer()).toBeUndefined()
  })
})
