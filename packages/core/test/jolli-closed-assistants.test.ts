import { afterEach, describe, expect, test } from "bun:test"
import { projectCatalog } from "../src/jolli/catalog"
import { JolliClosedAssistants } from "../src/jolli/closed-assistants"
import { Lookup } from "../src/jolli/lookup"

const course = {
  id: 7,
  name: "Systems Programming",
  description: "",
  code: "CS 310",
  status: "published",
  requiresCoding: true,
  endsOn: null,
  viewerRole: "course-student",
  isStaff: false,
}

/** A catalogue holding one assistant whose window ends at `endsAt`, and starts at `startsAt`. */
const catalogWith = (id: number, endsAt: string | null, startsAt: string | null = null) =>
  projectCatalog(
    {
      courses: [course],
      assistants: {
        "7": [
          {
            id,
            name: "Pair programmer",
            blurb: "",
            icon: "Terminal",
            accent: 0,
            worksThroughProblems: false,
            answersFromMaterialsOnly: false,
            showCitations: false,
            modelId: "",
            allowedModelIds: [],
            startsAt,
            endsAt,
          },
        ],
      },
      models: [],
    },
    "2026-10-15",
  )

const assistantOf = (catalog: ReturnType<typeof catalogWith>) => catalog.assistants[0]!

// A clock running behind the gateway's: the window still looks open from here.
const late = new Date("2026-10-15T10:00:00.000Z")
const endsAt = "2026-10-15T10:05:00.000Z"
const phaseOf = (catalog: ReturnType<typeof catalogWith>) => Lookup.windowPhase(assistantOf(catalog), late)
const served = (id: number, ends: string | null) => JolliClosedAssistants.apply(catalogWith(id, ends))

afterEach(() => JolliClosedAssistants.reset())

describe("JolliClosedAssistants", () => {
  test("an assistant the gateway refused as closed is served closed by a clock that trails it", () => {
    expect(phaseOf(catalogWith(101, endsAt))).toBe("open")

    JolliClosedAssistants.record("101")

    expect(phaseOf(served(101, endsAt))).toBe("after")
    // A refresh brings the same window back, and it stays closed.
    expect(phaseOf(served(101, endsAt))).toBe("after")
  })

  // `windowPhase` reads a start first, and "not open yet" lets an existing chat go on.
  test("a refused assistant is closed to a clock that trails even its start", () => {
    const window = catalogWith(108, endsAt, "2026-10-15T10:01:00.000Z")
    expect(phaseOf(window)).toBe("before")

    JolliClosedAssistants.record("108")

    expect(phaseOf(JolliClosedAssistants.apply(window))).toBe("after")
  })

  test("a window the teacher has since extended is served as the catalogue says", () => {
    JolliClosedAssistants.record("102")
    served(102, endsAt)

    expect(assistantOf(served(102, "2026-10-16T10:00:00.000Z")).endsAt).toBe("2026-10-16T10:00:00.000Z")
    // The record is gone, so going back to the old window is not judged by it either.
    expect(assistantOf(served(102, endsAt)).endsAt).toBe(endsAt)
  })

  test("a window cleared reopens it", () => {
    JolliClosedAssistants.record("103")
    served(103, endsAt)
    expect(assistantOf(served(103, null)).endsAt).toBeNull()
  })

  /**
   * ⚠ THE GATEWAY REFUSES AS CLOSED ONLY PAST AN END. A snapshot served first with none predates the
   * window that closed the assistant, and the end the next refresh brings is that window, not a new one.
   */
  test("an end arriving where the first snapshot had none keeps it closed", () => {
    JolliClosedAssistants.record("104")
    served(104, null)
    expect(phaseOf(served(104, endsAt))).toBe("after")
  })

  /**
   * ⚠ A STALE SNAPSHOT CAN BE SERVED FIRST. A window shortened since then comes back earlier on the
   * next refresh; that is the same closure stated more tightly, not a reopening.
   */
  test("a window that comes back earlier stays closed", () => {
    JolliClosedAssistants.record("105")
    served(105, endsAt)
    expect(phaseOf(served(105, "2026-10-15T10:01:00.000Z"))).toBe("after")
    expect(phaseOf(served(105, "2026-10-15T10:01:00.000Z"))).toBe("after")
  })

  test("an assistant nobody refused is untouched, and sign-out forgets every refusal", () => {
    expect(assistantOf(served(106, endsAt)).endsAt).toBe(endsAt)

    JolliClosedAssistants.record("107")
    JolliClosedAssistants.reset()
    expect(assistantOf(served(107, endsAt)).endsAt).toBe(endsAt)
  })
})
