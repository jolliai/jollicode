import { describe, expect, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import { Lookup } from "../src/jolli/lookup"

const course = (id: string, entryState: Jolli.CourseEntryState, assistantIds: string[] = []): Jolli.Course => ({
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

const assistant = (id: string, courseId: string, isDefault = false): Jolli.Assistant => ({
  id,
  courseId,
  name: `Assistant ${id}`,
  kind: "code",
  blurb: "",
  icon: "Sparkles",
  accent: 1,
  ...(isDefault ? { isDefault: true } : {}),
  instructions: "",
  allowedModelIds: [],
  guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
  coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
  skills: [],
  status: "live",
})

const catalog = (courses: Jolli.Course[], assistants: Jolli.Assistant[]) => ({ courses, assistants })

describe("assistantsForCourse", () => {
  /**
   * The gateway withholds `isDefault` and expresses the professor's default by sorting it first, so
   * an implementation that filtered the flat list instead would silently reorder their choice.
   */
  test("follows the course's order rather than the flat list's", () => {
    const data = catalog([course("1", "open", ["b", "a"])], [assistant("a", "1"), assistant("b", "1")])
    expect(Lookup.assistantsForCourse(data, "1").map((item) => item.id)).toEqual(["b", "a"])
  })

  test("skips ids the catalogue does not carry rather than emitting holes", () => {
    const data = catalog([course("1", "open", ["a", "ghost"])], [assistant("a", "1")])
    expect(Lookup.assistantsForCourse(data, "1").map((item) => item.id)).toEqual(["a"])
  })

  test("an unknown or absent course has none", () => {
    const data = catalog([course("1", "open", ["a"])], [assistant("a", "1")])
    expect(Lookup.assistantsForCourse(data, "stranger")).toEqual([])
    expect(Lookup.assistantsForCourse(data, undefined)).toEqual([])
  })
})

describe("defaultAssistantFor", () => {
  test("prefers the flagged default over position", () => {
    const data = catalog([course("1", "open", ["a", "b"])], [assistant("a", "1"), assistant("b", "1", true)])
    expect(Lookup.defaultAssistantFor(data, "1")?.id).toBe("b")
  })

  test("falls back to the first when nothing is flagged", () => {
    const data = catalog([course("1", "open", ["a", "b"])], [assistant("a", "1"), assistant("b", "1")])
    expect(Lookup.defaultAssistantFor(data, "1")?.id).toBe("a")
  })
})

describe("canStartSession", () => {
  test("needs an open course AND an assistant", () => {
    expect(Lookup.canStartSession(catalog([course("1", "open", ["a"])], [assistant("a", "1")]), "1")).toBe(true)
    expect(Lookup.canStartSession(catalog([course("1", "open")], []), "1")).toBe(false)
  })

  test("refuses every non-open state", () => {
    for (const state of ["draft", "not-yet", "ended", "archived"] as const) {
      const data = catalog([course("1", state, ["a"])], [assistant("a", "1")])
      expect(Lookup.canStartSession(data, "1")).toBe(false)
    }
  })

  test("a course nobody has heard of cannot be started", () => {
    expect(Lookup.canStartSession(catalog([], []), "stranger")).toBe(false)
  })
})

describe("blockedReason", () => {
  /**
   * ⚠ EACH STATE KEEPS ITS OWN VALUE. They lead to different next actions, so a single
   * "unavailable" would throw away the only useful part of the answer — and each renderer words
   * them itself, which it cannot do if they arrive collapsed.
   */
  test("names the state that is in the way", () => {
    for (const state of ["draft", "not-yet", "ended", "archived"] as const) {
      const item = course("1", state, ["a"])
      expect(Lookup.blockedReason(catalog([item], [assistant("a", "1")]), item)).toBe(state)
    }
  })

  test("an open course with no assistant blames the assistant, not the course", () => {
    const item = course("1", "open")
    expect(Lookup.blockedReason(catalog([item], []), item)).toBe("no-assistants")
  })

  test("says nothing about a course that can be started", () => {
    const item = course("1", "open", ["a"])
    expect(Lookup.blockedReason(catalog([item], [assistant("a", "1")]), item)).toBeUndefined()
  })
})

describe("parseModelKey", () => {
  /**
   * ⚠ THE FIRST SLASH IS THE SEPARATOR. A provider id never contains one; a model id may, so
   * splitting from the right would move part of the model into the provider.
   */
  test("splits on the first slash so a vendored model id survives", () => {
    expect(Lookup.parseModelKey("jolli/vendor/family/name")).toEqual({
      providerID: "jolli",
      modelID: "vendor/family/name",
    })
  })

  test("anything without a leading provider is not a key", () => {
    expect(Lookup.parseModelKey(undefined)).toBeUndefined()
    expect(Lookup.parseModelKey("")).toBeUndefined()
    expect(Lookup.parseModelKey("opus")).toBeUndefined()
    expect(Lookup.parseModelKey("/opus")).toBeUndefined()
  })
})

describe("isModelAllowed", () => {
  /**
   * ⚠ AN EMPTY GRANT MEANS UNRESTRICTED. A course that never configured model access must behave
   * exactly as the product did before grants existed — an empty picker would read as a broken app.
   */
  test("an empty grant allows everything", () => {
    expect(Lookup.isModelAllowed([], "jolli", "anything")).toBe(true)
  })

  test("a grant admits only what it names", () => {
    const grant = ["jolli/opus", "jolli/sonnet"]
    expect(Lookup.isModelAllowed(grant, "jolli", "opus")).toBe(true)
    expect(Lookup.isModelAllowed(grant, "jolli", "haiku")).toBe(false)
  })

  test("the provider is part of the key, not decoration", () => {
    expect(Lookup.isModelAllowed(["jolli/opus"], "anthropic", "opus")).toBe(false)
  })
})
