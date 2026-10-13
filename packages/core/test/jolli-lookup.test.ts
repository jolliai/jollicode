import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { Jolli } from "@opencode-ai/schema/jolli"
import { Lookup } from "../src/jolli/lookup"

/** A fixed instant every case reads the clock as, so a window boundary is a fact of the test. */
const NOW = new Date("2026-10-13T12:00:00.000Z")

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

const assistant = (
  id: string,
  courseId: string,
  isDefault = false,
  window: Partial<Pick<Jolli.Assistant, "startsAt" | "endsAt" | "directChatEnabled">> = {},
): Jolli.Assistant => ({
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
  ...window,
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
    expect(Lookup.canStartSession(catalog([course("1", "open", ["a"])], [assistant("a", "1")]), "1", NOW)).toBe(true)
    expect(Lookup.canStartSession(catalog([course("1", "open")], []), "1", NOW)).toBe(false)
  })

  test("refuses every non-open state", () => {
    for (const state of ["draft", "not-yet", "ended", "archived"] as const) {
      const data = catalog([course("1", state, ["a"])], [assistant("a", "1")])
      expect(Lookup.canStartSession(data, "1", NOW)).toBe(false)
    }
  })

  test("a course nobody has heard of cannot be started", () => {
    expect(Lookup.canStartSession(catalog([], []), "stranger", NOW)).toBe(false)
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
      expect(Lookup.blockedReason(catalog([item], [assistant("a", "1")]), item, NOW)).toBe(state)
    }
  })

  test("an open course with no assistant blames the assistant, not the course", () => {
    const item = course("1", "open")
    expect(Lookup.blockedReason(catalog([item], []), item, NOW)).toBe("no-assistants")
  })

  test("says nothing about a course that can be started", () => {
    const item = course("1", "open", ["a"])
    expect(Lookup.blockedReason(catalog([item], [assistant("a", "1")]), item, NOW)).toBeUndefined()
  })
})

describe("blockedReason — availability windows", () => {
  const closed = assistant("a", "1", true, { endsAt: "2026-10-12T00:00:00.000Z" })
  const later = assistant("b", "1", false, { startsAt: "2026-10-20T00:00:00.000Z" })

  /**
   * ⚠ ONLY A STUDENT IS BLOCKED. Every assistant being out of its window leaves the course with
   * assistants, so this is its own reason rather than `no-assistants`.
   */
  test("a student with every assistant outside its window is told none is open", () => {
    const item = course("1", "open", ["a", "b"])
    const data = catalog([item], [closed, later])
    expect(Lookup.blockedReason(data, item, NOW)).toBe("no-open-assistants")
    expect(Lookup.canStartSession(data, "1", NOW)).toBe(false)
  })

  // Staff are exempt from the windows on the gateway, so they may still try them.
  test("staff are never blocked by a window", () => {
    const item = { ...course("1", "open", ["a", "b"]), isStaff: true }
    const data = catalog([item], [closed, later])
    expect(Lookup.blockedReason(data, item, NOW)).toBeUndefined()
    expect(Lookup.canStartSession(data, "1", NOW)).toBe(true)
  })

  test("one open assistant is enough", () => {
    const item = course("1", "open", ["a", "b", "c"])
    expect(Lookup.blockedReason(catalog([item], [closed, later, assistant("c", "1")]), item, NOW)).toBeUndefined()
  })

  // The course's own state still answers first: a draft is a draft whatever its assistants say.
  test("a course that is not open is blamed before its windows", () => {
    const item = course("1", "ended", ["a"])
    expect(Lookup.blockedReason(catalog([item], [closed]), item, NOW)).toBe("ended")
  })
})

describe("windowPhase", () => {
  const at = (startsAt: string | null, endsAt: string | null) =>
    Lookup.windowPhase(assistant("a", "1", false, { startsAt, endsAt }), NOW)

  /** ⚠ THE START IS INSIDE AND THE END IS NOT, as Jolli Edu's `availabilityWindowPhase` draws it. */
  test("the start instant is open and the end instant is closed", () => {
    expect(at(NOW.toISOString(), null)).toBe("open")
    expect(at(null, NOW.toISOString())).toBe("after")
  })

  test("before the start, inside, and after the end", () => {
    expect(at("2026-10-13T12:00:00.001Z", null)).toBe("before")
    expect(at("2026-10-01T00:00:00.000Z", "2026-10-20T00:00:00.000Z")).toBe("open")
    expect(at("2026-10-01T00:00:00.000Z", "2026-10-13T11:59:59.999Z")).toBe("after")
  })

  // A server that predates windows sends nothing; an unreadable value must not close an assistant.
  test("an absent, null or unreadable side is unbounded", () => {
    expect(Lookup.windowPhase(assistant("a", "1"), NOW)).toBe("open")
    expect(at(null, null)).toBe("open")
    expect(at("not a date", "nor this")).toBe("open")
  })
})

describe("isDirectlyStartable", () => {
  test("needs direct chat AND an open window", () => {
    expect(Lookup.isDirectlyStartable(assistant("a", "1"), NOW)).toBe(true)
    expect(Lookup.isDirectlyStartable(assistant("a", "1", false, { directChatEnabled: false }), NOW)).toBe(false)
    expect(Lookup.isDirectlyStartable(assistant("a", "1", false, { startsAt: "2026-10-20T00:00:00.000Z" }), NOW)).toBe(
      false,
    )
    expect(Lookup.isDirectlyStartable(assistant("a", "1", false, { endsAt: NOW.toISOString() }), NOW)).toBe(false)
  })
})

describe("startableAssistants", () => {
  const list = [
    assistant("a", "1", true, { endsAt: "2026-10-12T00:00:00.000Z" }),
    assistant("b", "1"),
    assistant("c", "1", false, { directChatEnabled: false }),
    assistant("d", "1"),
  ]

  test("a student sees only what may start now, in the course's order", () => {
    expect(Lookup.startableAssistants(course("1", "open"), list, NOW).map((item) => item.id)).toEqual(["b", "d"])
  })

  test("staff see every assistant", () => {
    const staff = { ...course("1", "open"), isStaff: true }
    expect(Lookup.startableAssistants(staff, list, NOW).map((item) => item.id)).toEqual(["a", "b", "c", "d"])
  })

  /** ⚠ THE CATALOGUE IS NOT FILTERED. A session bound to a closed assistant still names it. */
  test("the full list stays available for existing sessions", () => {
    const data = catalog([course("1", "open", ["a", "b"])], list)
    expect(Lookup.assistantsForCourse(data, "1").map((item) => item.id)).toEqual(["a", "b"])
    expect(Lookup.defaultAssistantFor(data, "1")?.id).toBe("a")
  })
})

describe("pickAssistant", () => {
  const filtered = [assistant("b", "1"), assistant("d", "1")]

  test("keeps the preferred one when it survived the filter", () => {
    expect(Lookup.pickAssistant(filtered, "d")?.id).toBe("d")
  })

  // The professor's default is closed: the first open one stands in, without becoming the default.
  test("falls back to the first when the preferred one was filtered out or not given", () => {
    expect(Lookup.pickAssistant(filtered, "a")?.id).toBe("b")
    expect(Lookup.pickAssistant(filtered)?.id).toBe("b")
    expect(Lookup.pickAssistant(filtered)?.isDefault).toBeUndefined()
  })

  test("an empty list picks nobody", () => {
    expect(Lookup.pickAssistant([], "a")).toBeUndefined()
  })
})

describe("nextWindowBoundaryAt", () => {
  const GRACE = 2_000
  const at = (iso: string) => Date.parse(iso)

  test("ticks at the soonest start or end still ahead", () => {
    const list = [
      assistant("a", "1", false, { startsAt: "2026-10-13T13:00:00.000Z" }),
      assistant("b", "1", false, { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-13T12:30:00.000Z" }),
    ]
    expect(Lookup.nextWindowBoundaryAt(list, NOW)).toBe(at("2026-10-13T12:30:00.000Z"))
  })

  /**
   * ⚠ A START WAITS OUT THE GATEWAY'S CLOCK; AN END DOES NOT. Ticking late on an end would keep a
   * chat on offer while the gateway already refuses it.
   */
  test("adds the grace to a start and nothing to an end", () => {
    const opening = [assistant("a", "1", false, { startsAt: "2026-10-13T12:30:00.000Z" })]
    expect(Lookup.nextWindowBoundaryAt(opening, NOW)).toBe(at("2026-10-13T12:30:00.000Z") + GRACE)
    const closing = [assistant("a", "1", false, { endsAt: "2026-10-13T12:30:00.000Z" })]
    expect(Lookup.nextWindowBoundaryAt(closing, NOW)).toBe(at("2026-10-13T12:30:00.000Z"))
    expect(Lookup.windowPhase(closing[0], new Date(at("2026-10-13T12:30:00.000Z")))).toBe("after")
  })

  // A boundary exactly now has already been crossed; the next read sees it.
  test("ignores boundaries at or before now", () => {
    const list = [assistant("a", "1", false, { startsAt: NOW.toISOString(), endsAt: "2026-10-12T00:00:00.000Z" })]
    expect(Lookup.nextWindowBoundaryAt(list, NOW)).toBeUndefined()
  })

  test("nothing ahead, or no windows at all, means no tick", () => {
    expect(Lookup.nextWindowBoundaryAt([assistant("a", "1")], NOW)).toBeUndefined()
    expect(Lookup.nextWindowBoundaryAt([], NOW)).toBeUndefined()
  })
})

describe("watchBoundary", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
  })
  afterEach(() => jest.useRealTimers())

  test("fires at once when already due", () => {
    const fired: number[] = []
    Lookup.watchBoundary(NOW.getTime(), () => fired.push(Date.now()))
    expect(fired).toEqual([NOW.getTime()])
  })

  test("fires when the wall clock reaches the boundary, not before", () => {
    const fired: number[] = []
    Lookup.watchBoundary(NOW.getTime() + 30_000, () => fired.push(Date.now()))
    jest.advanceTimersByTime(29_999)
    expect(fired).toEqual([])
    jest.advanceTimersByTime(1)
    expect(fired).toEqual([NOW.getTime() + 30_000])
  })

  /**
   * ⚠ A SUSPENDED MACHINE STOPS ITS TIMERS BUT NOT ITS WALL CLOCK. A jump in system time with no timer
   * progress is what waking from sleep looks like; the next check must catch it rather than wait out
   * the rest of the original delay.
   */
  test("catches a boundary the wall clock jumped past while timers were stopped", () => {
    const fired: number[] = []
    Lookup.watchBoundary(NOW.getTime() + 2 * 3_600_000, () => fired.push(Date.now()))
    jest.setSystemTime(NOW.getTime() + 15 * 3_600_000)
    jest.advanceTimersByTime(60_000)
    expect(fired).toHaveLength(1)
  })

  test("cancelling stops it", () => {
    const fired: number[] = []
    const cancel = Lookup.watchBoundary(NOW.getTime() + 30_000, () => fired.push(Date.now()))
    cancel()
    jest.advanceTimersByTime(60_000)
    expect(fired).toEqual([])
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
