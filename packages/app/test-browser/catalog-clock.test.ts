import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { canStartSession, resetCatalog, setCatalog } from "@/jolli/catalog"
import type { Assistant, Catalog, Course } from "@/jolli/types"

const start = new Date("2026-10-13T12:00:00Z")

const course: Course = {
  id: "1",
  code: "CS 101",
  title: "Intro",
  kind: "code",
  accent: 1,
  assistantIds: ["a"],
  status: "published",
  entryState: "open",
  endsOn: null,
}

const assistant: Assistant = {
  id: "a",
  courseId: "1",
  name: "Assistant",
  kind: "code",
  icon: "Sparkles",
  blurb: "",
  accent: 1,
  isDefault: true,
  instructions: "",
  allowedModelIds: [],
  guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
  coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
  skills: [],
  status: "live",
  endsAt: new Date(start.getTime() + 60_000).toISOString(),
}

const catalog: Catalog = { status: "ok", courses: [course], assistants: [assistant], modelTiers: {} }

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(start)
})

afterEach(() => {
  resetCatalog()
  jest.useRealTimers()
})

/**
 * ⚠ A CALLER THAT PASSES NO `now` STILL FOLLOWS THE WINDOW CLOCK. The sidebar's "+" is one; it used
 * to read `new Date()` once and stay enabled after the assistant's window had closed.
 */
describe("windowNow", () => {
  test("a memo that calls canStartSession with no time re-runs when a window closes", () => {
    setCatalog(catalog)
    const view = createRoot((dispose) => ({ startable: createMemo(() => canStartSession("1")), dispose }))
    expect(view.startable()).toBe(true)

    // An end ticks on the boundary itself — see `Lookup.nextWindowBoundaryAt`.
    jest.advanceTimersByTime(60_000)
    expect(view.startable()).toBe(false)
    view.dispose()
  })
})
