import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createWindowClock } from "@/jolli/window-clock"
import type { Assistant } from "@/jolli/types"

const start = new Date("2026-10-13T12:00:00Z")

const assistant = (window: Partial<Assistant>): Assistant => ({
  id: "a",
  courseId: "1",
  name: "Assistant",
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
  ...window,
})

const at = (offsetMs: number) => new Date(start.getTime() + offsetMs).toISOString()

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(start)
})

afterEach(() => {
  jest.useRealTimers()
})

/**
 * The pickers re-judge which assistants may start only when this ticks, so it has to tick at every
 * boundary — including the second one, after the first tick re-arms it — and never otherwise.
 */
describe("createWindowClock", () => {
  // Effects created inside a root run once the root returns, so the clock is armed after this.
  const mount = (assistants: () => Assistant[]) =>
    createRoot((dispose) => ({ now: createWindowClock(assistants), dispose }))

  test("ticks at each boundary, re-arming for the next", () => {
    const clock = mount(() => [assistant({ startsAt: at(60_000), endsAt: at(120_000) })])
    expect(clock.now().getTime()).toBe(start.getTime())

    // An opening waits out the grace that keeps it behind the gateway's clock.
    jest.advanceTimersByTime(60_000)
    expect(clock.now().getTime()).toBe(start.getTime())

    jest.advanceTimersByTime(2_000)
    expect(clock.now().getTime()).toBe(start.getTime() + 62_000)

    // A closing does not: late here, the chat would stay on offer while the gateway refuses it.
    jest.advanceTimersByTime(58_000)
    expect(clock.now().getTime()).toBe(start.getTime() + 120_000)
    clock.dispose()
  })

  /**
   * ⚠ A SUSPENDED MACHINE STOPS ITS TIMERS, NOT ITS WALL CLOCK. Lid shut two hours before a window
   * ends and opened fifteen hours later: the clock must catch up at its next check, not two waking
   * hours on.
   */
  test("catches up after the machine slept through a boundary", () => {
    const clock = mount(() => [assistant({ endsAt: at(2 * 3_600_000) })])
    jest.setSystemTime(start.getTime() + 15 * 3_600_000)
    jest.advanceTimersByTime(60_000)
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(start.getTime() + 15 * 3_600_000)
    clock.dispose()
  })

  test("never ticks when no boundary lies ahead", () => {
    const clock = mount(() => [assistant({ endsAt: at(-1_000) }), assistant({})])
    jest.advanceTimersByTime(24 * 60 * 60 * 1000)
    expect(clock.now().getTime()).toBe(start.getTime())
    clock.dispose()
  })

  test("re-arms when the catalogue brings a new window", () => {
    const [assistants, setAssistants] = createSignal<Assistant[]>([])
    const clock = mount(assistants)
    setAssistants([assistant({ endsAt: at(10_000) })])
    jest.advanceTimersByTime(10_000)
    expect(clock.now().getTime()).toBe(start.getTime() + 10_000)
    clock.dispose()
  })

  // An agent closed at 10:35:45 showed as closed only at 10:36:17: armed from the last tick.
  test("arms from the time a new catalogue lands, not from its last tick", () => {
    const [assistants, setAssistants] = createSignal<Assistant[]>([])
    const clock = mount(assistants)
    jest.advanceTimersByTime(90_000)
    setAssistants([assistant({ endsAt: at(100_000) })])
    jest.advanceTimersByTime(10_000)
    expect(clock.now().getTime()).toBe(start.getTime() + 100_000)
    clock.dispose()
  })

  test("stops when its owner is disposed", () => {
    const clock = mount(() => [assistant({ endsAt: at(10_000) })])
    clock.dispose()
    jest.advanceTimersByTime(12_000)
    expect(clock.now().getTime()).toBe(start.getTime())
  })
})
