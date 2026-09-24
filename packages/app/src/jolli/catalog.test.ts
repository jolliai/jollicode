import { beforeEach, describe, expect, test } from "bun:test"
import {
  assistantsForCourse,
  canStartSession,
  courseById,
  defaultAssistantFor,
  enrolledCourses,
  listedCourses,
  ready,
  resetCatalog,
  setCatalog,
} from "./catalog"
import type { Assistant, Catalog, Course, CourseEntryState } from "./types"

const course = (id: string, entryState: CourseEntryState, assistantIds: string[] = []): Course => ({
  id,
  code: `CS ${id}`,
  title: "A course",
  kind: "code",
  accent: 1,
  assistantIds,
  status: entryState === "draft" ? "draft" : entryState === "archived" ? "archived" : "published",
  entryState,
  endsOn: null,
})

const assistant = (id: string, courseId: string, isDefault = false): Assistant => ({
  id,
  courseId,
  name: `Assistant ${id}`,
  kind: "code",
  icon: "Sparkles",
  blurb: "",
  accent: 1,
  ...(isDefault ? { isDefault: true } : {}),
  instructions: "",
  allowedModelIds: [],
  guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
  coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
  skills: [],
  status: "live",
})

const catalog = (courses: Course[], assistants: Assistant[]): Catalog => ({
  status: "ok",
  courses,
  assistants,
  modelTiers: {},
})

beforeEach(() => resetCatalog())

describe("ready", () => {
  // The one caller that needs this is auto-selection: "no courses" and "still loading" are the
  // same empty list, and acting on the second would select nothing and never revisit it.
  test("is false until an answer lands, then true even for an empty one", () => {
    expect(ready()).toBe(false)
    setCatalog(catalog([], []))
    expect(ready()).toBe(true)
  })
})

describe("enrolledCourses", () => {
  /**
   * ⚠ A REVERSAL FROM THE FIXTURES, WHICH HID DRAFTS. A student whose only course is unpublished
   * would otherwise meet an empty list that cannot say why, where a disabled row can.
   */
  test("includes courses that cannot be started", () => {
    setCatalog(catalog([course("1", "open"), course("2", "draft"), course("3", "ended")], []))
    expect(enrolledCourses().map((c) => c.id)).toEqual(["1", "2", "3"])
  })
})

describe("listedCourses", () => {
  test("hides what cannot be started while anything can", () => {
    setCatalog(
      catalog(
        [course("1", "open", ["a"]), course("2", "draft", ["b"]), course("3", "ended", ["c"])],
        [assistant("a", "1"), assistant("b", "2"), assistant("c", "3")],
      ),
    )
    expect(listedCourses().map((c) => c.id)).toEqual(["1"])
  })

  /**
   * ⚠ THE CASE THE WHOLE RULE EXISTS FOR. With nothing startable the filter would empty the column,
   * and an empty column cannot say "your instructor hasn't published this yet".
   */
  test("shows everything when nothing can be started", () => {
    setCatalog(catalog([course("1", "draft"), course("2", "archived")], []))
    expect(listedCourses().map((c) => c.id)).toEqual(["1", "2"])
  })

  // An open course with nobody to answer is not startable either, so it is filtered like a draft.
  test("counts an open course with no assistant as unstartable", () => {
    setCatalog(catalog([course("1", "open", ["a"]), course("2", "open")], [assistant("a", "1")]))
    expect(listedCourses().map((c) => c.id)).toEqual(["1"])
  })

  test("stays empty for a student with no enrolments", () => {
    setCatalog(catalog([], []))
    expect(listedCourses()).toEqual([])
  })
})

describe("canStartSession", () => {
  test("needs an open course AND an assistant", () => {
    setCatalog(
      catalog(
        [course("1", "open", ["a"]), course("2", "open"), course("3", "draft", ["b"])],
        [assistant("a", "1"), assistant("b", "3")],
      ),
    )
    expect(canStartSession("1")).toBe(true)
    // Open, but the professor has configured nobody to answer.
    expect(canStartSession("2")).toBe(false)
    // Has an assistant, but the course is not open.
    expect(canStartSession("3")).toBe(false)
    expect(canStartSession(undefined)).toBe(false)
  })

  // It asks entryState rather than status, so a published course that has ended is refused.
  test("refuses every non-open state", () => {
    for (const state of ["draft", "not-yet", "ended", "archived"] as const) {
      setCatalog(catalog([course("1", state, ["a"])], [assistant("a", "1")]))
      expect(canStartSession("1")).toBe(false)
    }
  })
})

describe("assistantsForCourse", () => {
  /**
   * ⚠ ORDER IS THE PROFESSOR'S. The gateway withholds an isDefault flag and expresses the default by
   * sorting it first, so reading the course's own id list is what preserves the choice.
   */
  test("follows the course's order rather than the flat list's", () => {
    setCatalog(catalog([course("1", "open", ["b", "a"])], [assistant("a", "1"), assistant("b", "1")]))
    expect(assistantsForCourse("1").map((a) => a.id)).toEqual(["b", "a"])
  })

  test("skips ids the catalogue does not carry rather than emitting holes", () => {
    setCatalog(catalog([course("1", "open", ["a", "gone"])], [assistant("a", "1")]))
    expect(assistantsForCourse("1").map((a) => a.id)).toEqual(["a"])
  })

  test("an unknown course has none", () => {
    expect(assistantsForCourse("nope")).toEqual([])
  })
})

describe("defaultAssistantFor", () => {
  test("prefers the flagged default, else the first", () => {
    setCatalog(catalog([course("1", "open", ["a", "b"])], [assistant("a", "1"), assistant("b", "1", true)]))
    expect(defaultAssistantFor("1")?.id).toBe("b")

    setCatalog(catalog([course("2", "open", ["c", "d"])], [assistant("c", "2"), assistant("d", "2")]))
    expect(defaultAssistantFor("2")?.id).toBe("c")
  })
})

describe("courseById", () => {
  test("is undefined for nothing and for a stranger", () => {
    setCatalog(catalog([course("1", "open")], []))
    expect(courseById(undefined)).toBeUndefined()
    expect(courseById("nope")).toBeUndefined()
    expect(courseById("1")?.id).toBe("1")
  })
})

/**
 * ⚠ THE PAYLOAD IS TYPED `Catalog` AND ARRIVES OVER HTTP, WHICH ARE NOT THE SAME CLAIM. The only
 * caller reaches `setCatalog` through `response.data as Catalog` — an assertion with nothing behind
 * it — so these cases pin what happens when the body does not hold up.
 *
 * ⚠ THE CRASH WAS NOT A MISSING SECTION, IT WAS THE ERROR SCREEN. `enrolledCourses()` spreads the
 * stored array, so a `courses` that was not one made `[...undefined]` throw out of a render; the
 * sidebar reads it at the top of a layout mounted on every route, so the whole application went
 * down rather than one list.
 */
describe("setCatalog with an answer that is not a catalogue", () => {
  const malformed = [
    ["an empty body", {}],
    ["a null body", null],
    ["courses of the wrong type", { courses: { "1": course("1", "open") }, assistants: [] }],
    ["assistants of the wrong type", { courses: [], assistants: "none" }],
  ] as const

  for (const [name, body] of malformed) {
    test(`survives ${name}`, () => {
      setCatalog(body as unknown as Catalog)
      expect(enrolledCourses()).toEqual([])
      expect(assistantsForCourse("1")).toEqual([])
      expect(canStartSession("1")).toBe(false)
      // ⚠ STILL "ANSWERED". `ready` means the server replied, not that the reply was any good.
      expect(ready()).toBe(true)
    })
  }

  test("a later good answer replaces a bad one", () => {
    setCatalog({} as unknown as Catalog)
    setCatalog(catalog([course("1", "open", ["a"])], [assistant("a", "1")]))
    expect(enrolledCourses().map((item) => item.id)).toEqual(["1"])
  })
})
