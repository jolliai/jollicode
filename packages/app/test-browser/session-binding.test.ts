import { afterEach, beforeAll, beforeEach, expect, jest, mock, test } from "bun:test"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import type { Assistant, Catalog, Course } from "@/jolli/types"
import type { useCourseSession } from "@/jolli/session-binding"

type CourseSession = ReturnType<typeof useCourseSession>

const start = new Date("2026-10-13T12:00:00Z")

/** What `CourseSessionProvider` would run, called here under a real router instead of rendered. */
const captured: { init?: () => CourseSession } = {}

/**
 * ⚠ MODULE MOCKS OUTLIVE THE FILE, SO EVERY ONE HERE IS NARROW. The router is the real one. The
 * context helper is the real one too, only noting this provider's `init` on the way through — a
 * provider written in JSX cannot be rendered from another package under `bun test`. The layout, sync
 * and fetch hooks stand in for providers this test has no use for, and nothing else here imports them.
 */
beforeAll(async () => {
  // Taken before mocking: the mock replaces the module's bindings in place, `real` included.
  const real = await import("@opencode-ai/ui/context")
  const createSimpleContext = real.createSimpleContext
  mock.module("@opencode-ai/ui/context", () => ({
    ...real,
    createSimpleContext: (input: Parameters<typeof createSimpleContext>[0]) => {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the helper is generic; this is the one provider it is.
      if (input.name === "JolliCourseSession") captured.init = input.init as () => CourseSession
      return createSimpleContext(input)
    },
  }))
  mock.module("@/context/layout", () => ({
    useLayout: () => ({ route: () => ({ type: "draft", draftID: "d1" }) }),
  }))
  mock.module("@/context/sync", () => ({ useSync: () => () => ({ data: { session: [] } }) }))
  mock.module("@/jolli/catalog-fetch", () => ({ useJolliCatalog: () => undefined, useRefusalRefresh: () => undefined }))
})

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(start)
})

afterEach(async () => {
  const { resetCatalog } = await import("@/jolli/catalog")
  const { CourseIntent } = await import("@/jolli/course-intent")
  resetCatalog()
  CourseIntent.clear()
  jest.useRealTimers()
})

const course = (id: string, assistantIds: string[]): Course => ({
  id,
  code: `CS ${id}`,
  title: id,
  kind: "code",
  accent: 1,
  assistantIds,
  status: "published",
  entryState: "open",
  endsOn: null,
})

const assistant = (id: string, courseId: string, extra: Partial<Assistant> = {}): Assistant => ({
  id,
  courseId,
  name: id,
  kind: "code",
  icon: "Sparkles",
  blurb: "",
  accent: 1,
  isDefault: id === "A",
  instructions: "",
  allowedModelIds: [],
  guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
  coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
  skills: [],
  status: "live",
  ...extra,
})

/** CS 240 has A, its default, and B. CS 310's only assistant closes in a minute, so the clock ticks. */
const catalog = (): Catalog => ({
  status: "ok",
  courses: [course("310", ["C"]), course("240", ["A", "B"])],
  assistants: [
    assistant("C", "310", { endsAt: new Date(start.getTime() + 60_000).toISOString() }),
    assistant("A", "240"),
    assistant("B", "240"),
  ],
  modelTiers: {},
})

async function mount() {
  await import("@/jolli/session-binding")
  const view: { binding?: CourseSession } = {}
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history: createMemoryHistory(),
        get children() {
          return createComponent(Route, {
            path: "/",
            component: () => {
              view.binding = captured.init!()
              return null
            },
          })
        },
      }),
    host,
  )
  return { binding: view.binding!, dispose }
}

/**
 * ⚠ THE "+" REQUEST USED TO OUTLIVE THE CHOICE IT WAS MEANT TO SEED. It stays readable until the
 * session exists, and the effect that applies it tracks the catalogue and the window clock — so a
 * picker re-asking for the catalogue, or any window boundary, put the course's default back over the
 * assistant the student had just picked, and Start opened the one they had turned down.
 */
test("a '+' request does not put the default back over an assistant picked by hand", async () => {
  const { setCatalog } = await import("@/jolli/catalog")
  const { CourseIntent } = await import("@/jolli/course-intent")
  setCatalog(catalog())
  CourseIntent.request("240", "session:elsewhere")

  const view = await mount()
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "A" })

  view.binding.draft.setAssistant("B")
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "B" })

  setCatalog(catalog())
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "B" })

  jest.advanceTimersByTime(60_000)
  expect(view.binding.now().getTime()).toBe(start.getTime() + 60_000)
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "B" })
  view.dispose()
})

test("a '+' request still overrides the pre-selected course", async () => {
  const { setCatalog } = await import("@/jolli/catalog")
  const { CourseIntent } = await import("@/jolli/course-intent")
  setCatalog(catalog())

  const view = await mount()
  expect(view.binding.draft.value).toEqual({ courseId: "310", assistantId: "C" })

  CourseIntent.request("240", "session:elsewhere")
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "A" })
  view.dispose()
})

/**
 * ⚠ A START IS BOUND TO WHAT WAS SENT. The "+" branch re-applied its course at every window boundary,
 * outstanding Start or not, so a default closing mid-Start staged another assistant under it — and
 * one that does not open the conversation brought the prompt box back, with a second session behind it.
 */
test("a '+' request does not move the draft while a Start is outstanding", async () => {
  const { setCatalog } = await import("@/jolli/catalog")
  const { CourseIntent } = await import("@/jolli/course-intent")
  setCatalog({
    ...catalog(),
    assistants: [
      assistant("C", "310"),
      assistant("A", "240", { endsAt: new Date(start.getTime() + 60_000).toISOString() }),
      assistant("B", "240"),
    ],
  })
  CourseIntent.request("240", "session:elsewhere")

  const view = await mount()
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "A" })

  view.binding.draft.setStarting(true)
  jest.advanceTimersByTime(60_000)
  expect(view.binding.now().getTime()).toBe(start.getTime() + 60_000)
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "A" })

  view.binding.draft.setStarting(false)
  expect(view.binding.draft.value).toEqual({ courseId: "240", assistantId: "B" })
  view.dispose()
})
