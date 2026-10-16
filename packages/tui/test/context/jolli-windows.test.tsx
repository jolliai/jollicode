/** @jsxImportSource @opentui/solid */
/**
 * WHICH ASSISTANTS A NEW SESSION MAY OFFER, WHILE THEIR AVAILABILITY WINDOWS OPEN AND CLOSE.
 *
 * ⚠ THE WINDOWS ARE DRAWN RELATIVE TO THE REAL CLOCK, NOT A FAKE ONE. The context arms a real
 * `setTimeout` off `Lookup.watchBoundary`, and that timer is part of what is under test — so a
 * closed assistant here is one whose `endsAt` already passed, and one about to close ends a fraction
 * of a second from now.
 */
import { afterAll, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { JolliProvider, useJolli } from "../../src/context/jolli"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute, type Route } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/** The flag the shipped entry point sets; `noCourses()` and `blocked()` say nothing without it. */
const originalLockdown = process.env["JOLLICODE_LOCKDOWN"]
process.env["JOLLICODE_LOCKDOWN"] = "1"
afterAll(() => {
  if (originalLockdown === undefined) delete process.env["JOLLICODE_LOCKDOWN"]
  else process.env["JOLLICODE_LOCKDOWN"] = originalLockdown
})

/** ⚠ `Flock` REFUSES UNTIL A STATE DIRECTORY IS SET, and importing `Global` is what sets it. */
void Global.Path.state

const MODEL_KEY = `${providerIdFor("anthropic")}/opus`
const PAST = new Date(Date.now() - 86_400_000).toISOString()
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()

function course(id: string, assistantIds: string[], isStaff = false) {
  return {
    id,
    code: `C ${id}`,
    title: `C ${id}`,
    kind: "code",
    accent: 1,
    assistantIds,
    status: "published",
    entryState: "open",
    endsOn: null,
    isStaff,
  }
}

function assistant(id: string, courseId: string, window: { startsAt?: string; endsAt?: string } = {}) {
  return {
    id,
    courseId,
    name: `A ${id}`,
    kind: "code",
    blurb: "",
    accent: 1,
    isDefault: id === "1" || id === "4",
    instructions: "",
    allowedModelIds: [MODEL_KEY],
    modelId: MODEL_KEY,
    guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
    coaching: { coachTheQuestion: false, coachTheProcess: false, coachTheModelChoice: false, instructions: "" },
    skills: [],
    status: "live",
    brief: "",
    startsAt: window.startsAt ?? null,
    endsAt: window.endsAt ?? null,
    directChatEnabled: true,
    opensConversation: false,
  }
}

/**
 * Course 101: its default (1) has closed, 2 is open, 3 has not opened. Course 202 is all open, so
 * there are two startable courses and the auto-select branch never answers for the student.
 */
function catalog(isStaff = false) {
  return {
    status: "ok",
    courses: [course("101", ["1", "2", "3"], isStaff), course("202", ["4"], isStaff)],
    assistants: [
      assistant("1", "101", { endsAt: PAST }),
      assistant("2", "101"),
      assistant("3", "101", { startsAt: FUTURE }),
      assistant("4", "202"),
    ],
    modelTiers: {},
    account: "student-a",
  }
}

const SESSION_ID = "ses_bound"

async function mount(
  options: {
    catalog?: unknown
    /** Answers `/jolli/course` per request, for a case that needs the server to change its mind. */
    catalogFor?: (url: URL) => unknown
    route?: Route
    sessions?: unknown[]
    state?: string
  } = {},
) {
  const state = options.state ?? (await tmpdir()).path
  if (!options.state) await Bun.write(`${state}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/jolli/course")
      return Promise.resolve(json(options.catalogFor?.(url) ?? options.catalog ?? catalog()))
    if (url.pathname === "/provider")
      return Promise.resolve(json({ all: [], default: {}, connected: [providerIdFor("anthropic")] }))
    if (url.pathname === "/session") return Promise.resolve(json(options.sessions ?? []))
    return undefined
  })
  const config = createTuiResolvedConfig()

  let jolli!: ReturnType<typeof useJolli>
  let route!: ReturnType<typeof useRoute>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const captured = useJolli()
    const capturedRoute = useRoute()
    onMount(() => {
      jolli = captured
      route = capturedRoute
      mounted()
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state }}>
        <ClipboardProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <TuiConfigProvider config={config}>
                    <RouteProvider initialRoute={options.route ?? { type: "home" }}>
                      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <ThemeProvider mode="dark">
                                  <JolliProvider>
                                    <DialogProvider>
                                      <Probe />
                                    </DialogProvider>
                                  </JolliProvider>
                                </ThemeProvider>
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </RouteProvider>
                  </TuiConfigProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30 })
  await ready
  await app.waitFor(() => jolli.loaded())
  await app.renderOnce()
  return {
    app,
    state,
    events,
    get jolli() {
      return jolli
    },
    get route() {
      return route
    },
    close() {
      app.renderer.destroy()
    },
  }
}

/** Waits on the clock, not render passes: a window boundary is a timer away. */
async function until(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id)

/** A turn the provider failed, as the session reports it, carrying `responseBody` from the gateway. */
const turnFailed = (responseBody: string) => ({
  directory,
  project: "proj_test",
  payload: {
    id: "evt_error",
    type: "session.error" as const,
    properties: {
      sessionID: SESSION_ID,
      error: { name: "APIError" as const, data: { message: "Forbidden", isRetryable: false, responseBody } },
    },
  },
})

/**
 * ⚠ THE SIDECAR LEARNED OF THE CLOSURE FROM THE TURN; THE LIST HERE DID NOT. Asking again past the
 * server's cache is what stops the next new chat being staged on the same closed assistant.
 */
test("a turn the gateway refused asks for the catalogue again, and nothing else does", async () => {
  let fresh = 0
  const view = await mount({
    catalogFor: (url) => {
      if (url.searchParams.get("fresh") === "true") fresh++
      return catalog()
    },
  })
  try {
    view.events.emit(turnFailed(JSON.stringify({ error: "Too many requests", code: "rate_limited" })))
    view.events.emit(turnFailed("Bad Gateway"))
    await Bun.sleep(50)
    expect(fresh).toBe(0)

    view.events.emit(turnFailed(JSON.stringify({ error: "This agent has closed.", code: "assistant_closed" })))
    await until(() => fresh === 1)
  } finally {
    view.close()
  }
})

test("a student is offered only the assistants open right now", async () => {
  const view = await mount()
  try {
    expect(ids(view.jolli.assistantsFor("101"))).toEqual(["2"])
  } finally {
    view.close()
  }
})

/** ⚠ STAFF ARE EXEMPT ON THE GATEWAY, AND CAME TO TRY EXACTLY WHAT A FILTER WOULD HIDE. */
test("staff are offered every assistant, open or not", async () => {
  const view = await mount({ catalog: catalog(true) })
  try {
    expect(ids(view.jolli.assistantsFor("101"))).toEqual(["1", "2", "3"])
    view.jolli.draft.setCourse("101")
    expect(view.jolli.assistant()?.id).toBe("1")
  } finally {
    view.close()
  }
})

/**
 * ⚠ THE PROFESSOR'S DEFAULT IS CLOSED, SO THE DRAFT TAKES THE FIRST OPEN ONE — without that one
 * becoming "the default", which stays a property of the full list.
 */
test("choosing a course whose default has closed stages the first open assistant", async () => {
  const view = await mount()
  try {
    view.jolli.draft.setCourse("101")
    expect(view.jolli.draft.value).toEqual({ courseId: "101", assistantId: "2" })
    expect(view.jolli.assistant()?.isDefault).toBe(false)
  } finally {
    view.close()
  }
})

/** ⚠ REMEMBERED IS RE-RESOLVED AGAINST WHAT MAY START NOW, not trusted as the assistant to stage. */
test("a remembered assistant that has closed restores to an open one in the same course", async () => {
  const state = (await tmpdir()).path
  await Bun.write(
    `${state}/kv.json`,
    JSON.stringify({ jolli_last_course: { "student-a": { courseId: "101", assistantId: "1" } } }),
  )
  const view = await mount({ state })
  try {
    await view.app.waitFor(() => !!view.jolli.current())
    expect(view.jolli.draft.value).toEqual({ courseId: "101", assistantId: "2" })
  } finally {
    view.close()
  }
})

/**
 * ⚠ A LIVE SESSION STILL NAMES ITS CLOSED ASSISTANT, AND `/new` FROM IT DOES NOT STAGE IT. The
 * catalogue keeps every assistant so the first holds; the filter is what makes the second hold.
 */
test("a session bound to a closed assistant shows it, and the next draft moves to an open one", async () => {
  const view = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [
      {
        id: SESSION_ID,
        title: "bound",
        time: { created: 0, updated: 0 },
        version: "1.14.42",
        directory,
        project_id: "proj_test",
        metadata: { jolli: { courseId: "101", assistantId: "1" } },
      },
    ],
  })
  try {
    await view.app.waitFor(() => view.jolli.assistant()?.id === "1")
    expect(view.jolli.locked()).toBe(true)

    view.route.navigate({ type: "home" })
    await view.app.waitFor(() => !view.jolli.locked())
    expect(view.jolli.draft.value).toEqual({ courseId: "101", assistantId: "2" })
  } finally {
    view.close()
  }
})

/**
 * ⚠ EVERY COURSE HIDDEN FOR HAVING NOTHING OPEN IS NOT "NO COURSES". The gate still opens — there is
 * nothing to start — but it, and the composer, say the clock is the reason.
 */
test("when no course has an open assistant, the reason is that none is open", async () => {
  const view = await mount({
    catalog: {
      ...catalog(),
      assistants: [
        assistant("1", "101", { endsAt: PAST }),
        assistant("2", "101", { startsAt: FUTURE }),
        assistant("3", "101", { startsAt: FUTURE }),
        assistant("4", "202", { endsAt: PAST }),
      ],
    },
  })
  try {
    expect(view.jolli.courses()).toEqual([])
    expect(view.jolli.noCourses()).toBe(true)
    expect(view.jolli.noOpenAssistants()).toBe(true)
    expect(view.jolli.blocked()).toBe("No assistants are open right now — try again later.")
  } finally {
    view.close()
  }
})

test("a course with no assistants at all is not reported as having none open", async () => {
  const view = await mount({
    catalog: { ...catalog(), courses: [course("101", []), course("202", [])], assistants: [] },
  })
  try {
    expect(view.jolli.noCourses()).toBe(true)
    expect(view.jolli.noOpenAssistants()).toBe(false)
  } finally {
    view.close()
  }
})

/**
 * A CATALOGUE WHOSE ASSISTANT "1" CLOSES SHORTLY AFTER IT IS FIRST SERVED.
 *
 * ⚠ THE DEADLINE IS SET WHEN THE SERVER ANSWERS, NOT WHEN THE TEST STARTS, so the time `mount()`
 * takes on a slow machine is not taken out of the window. `expectOpen` then fails by name if the
 * window was missed anyway, rather than as a wrong assistant id.
 */
function closingSoon(ms = 1000) {
  let closing: number | undefined
  return {
    catalog: () => {
      closing ??= Date.now() + ms
      return {
        ...catalog(),
        assistants: [
          assistant("1", "101", { endsAt: new Date(closing).toISOString() }),
          assistant("2", "101"),
          assistant("3", "101", { startsAt: FUTURE }),
          assistant("4", "202"),
        ],
      }
    },
    remaining: () => Math.max(0, (closing ?? Date.now()) - Date.now()),
    expectOpen: () => expect(closing !== undefined && Date.now() < closing).toBe(true),
  }
}

/**
 * ⚠ NOTHING BUT THE CLOCK CHANGES AT A BOUNDARY. The staged assistant closes while the student sits
 * on the draft; the timer armed off the catalogue is the only thing that can notice, and the draft
 * has to move to an open one rather than wait for a prompt the gateway would refuse.
 */
test("a draft whose assistant closes moves to an open one when the window ends", async () => {
  const soon = closingSoon()
  const view = await mount({ catalogFor: soon.catalog })
  try {
    view.jolli.draft.setCourse("101")
    soon.expectOpen()
    expect(view.jolli.draft.value?.assistantId).toBe("1")
    await until(() => view.jolli.draft.value?.assistantId === "2", 4000)
    expect(ids(view.jolli.assistantsFor("101"))).toEqual(["2"])
  } finally {
    view.close()
  }
}, 8000)

/**
 * ⚠ A REFUSED START OR A PICKER OPENING RE-ASKS PAST THE SERVER'S CACHE, AND THE FIRST LOAD DOES NOT.
 * The server here answers a stale list unless asked for a fresh one, which is what its five-minute
 * snapshot does: a re-ask without `fresh` would keep the closed assistant staged.
 */
test("refreshing asks past the server's cache, and the draft leaves an assistant that closed", async () => {
  const asked: (string | null)[] = []
  const closed = {
    ...catalog(),
    assistants: [
      assistant("1", "101", { endsAt: PAST }),
      assistant("2", "101", { endsAt: PAST }),
      assistant("3", "101", { startsAt: FUTURE }),
      assistant("4", "202"),
    ],
  }
  const view = await mount({
    catalogFor: (url) => {
      asked.push(url.searchParams.get("fresh"))
      return url.searchParams.get("fresh") === "true" ? closed : catalog()
    },
  })
  try {
    await until(() => view.jolli.signedIn())
    view.jolli.draft.setCourse("101")
    expect(view.jolli.draft.value?.assistantId).toBe("2")
    expect(asked.every((fresh) => fresh === null)).toBe(true)

    view.jolli.refresh()
    await until(() => asked.includes("true"))
    // Course 101 has nothing open any more, so the draft is off it — dropped, or onto 202, the one left.
    await until(() => view.jolli.draft.value?.courseId !== "101")
    expect(ids(view.jolli.assistantsFor("101"))).toEqual([])
  } finally {
    view.close()
  }
})

/**
 * ⚠ AN UNREACHABLE ANSWER IS EMPTY LISTS, NOT AN EMPTY ENROLMENT. A refresh that lands while the
 * gateway is away must leave the student's draft where it was.
 */
test("a refresh the gateway does not answer keeps the draft", async () => {
  let reachable = true
  const view = await mount({
    catalogFor: () =>
      reachable
        ? catalog()
        : { status: "unreachable", courses: [], assistants: [], modelTiers: {}, account: "student-a" },
  })
  try {
    await until(() => view.jolli.signedIn())
    view.jolli.draft.setCourse("202")
    expect(view.jolli.draft.value).toEqual({ courseId: "202", assistantId: "4" })

    reachable = false
    view.jolli.refresh()
    await until(() => view.jolli.unreachable())
    expect(view.jolli.draft.value).toEqual({ courseId: "202", assistantId: "4" })
  } finally {
    view.close()
  }
})

/** ⚠ OPENING A PICKER RE-ASKS, BUT OPENING IT AGAIN A MOMENT LATER DOES NOT COST ANOTHER LOAD. */
test("a recheck right after a refresh does not ask again", async () => {
  const asked: (string | null)[] = []
  const view = await mount({
    catalogFor: (url) => {
      asked.push(url.searchParams.get("fresh"))
      return catalog()
    },
  })
  try {
    await until(() => view.jolli.signedIn())
    view.jolli.recheck()
    await until(() => asked.includes("true"))
    const count = asked.length
    view.jolli.recheck()
    await Bun.sleep(50)
    expect(asked).toHaveLength(count)
  } finally {
    view.close()
  }
})

/**
 * ⚠ THE STAND-IN IS STAGED, NOT REMEMBERED. Viewing a session whose assistant has closed puts an open
 * one on the next draft, but the student's own choice is what stays on disk for the next launch.
 */
test("viewing a session whose assistant has closed remembers that assistant, not the stand-in", async () => {
  const state = (await tmpdir()).path
  await Bun.write(`${state}/kv.json`, "{}")
  const view = await mount({
    state,
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [
      {
        id: SESSION_ID,
        title: "bound",
        time: { created: 0, updated: 0 },
        version: "1.14.42",
        directory,
        project_id: "proj_test",
        metadata: { jolli: { courseId: "101", assistantId: "1" } },
      },
    ],
  })
  try {
    await view.app.waitFor(() => view.jolli.assistant()?.id === "1")
    view.route.navigate({ type: "home" })
    await view.app.waitFor(() => !view.jolli.locked())
    expect(view.jolli.draft.value).toEqual({ courseId: "101", assistantId: "2" })
    const saved = async () => (await Bun.file(`${state}/kv.json`).json()).jolli_last_course?.["student-a"]
    for (let tries = 0; tries < 200 && !(await saved()); tries++) await Bun.sleep(10)
    expect(await saved()).toEqual({ courseId: "101", assistantId: "1" })
  } finally {
    view.close()
  }
})

/** ⚠ A START IS BOUND TO WHAT WAS SENT; THE DRAFT MUST NOT MOVE UNDER IT WHILE IT WAITS. */
test("a draft whose assistant closes during a Start stays put until the Start is answered", async () => {
  const soon = closingSoon()
  const view = await mount({ catalogFor: soon.catalog })
  try {
    view.jolli.draft.setCourse("101")
    soon.expectOpen()
    expect(view.jolli.draft.value?.assistantId).toBe("1")
    view.jolli.setStarting(true)
    // Past the boundary, when the timer has fired and the clock moved on.
    await Bun.sleep(soon.remaining() + 500)
    expect(view.jolli.draft.value?.assistantId).toBe("1")
    view.jolli.setStarting(false)
    await until(() => view.jolli.draft.value?.assistantId === "2", 2000)
  } finally {
    view.close()
  }
}, 10000)

/**
 * ⚠ A DRAFT DROPPED BY A CLOSING WINDOW COMES BACK WHEN ONE OPENS. The sole course was staged by the
 * restore effect, which then closed its latch; dropping the draft left the latch closed, so when the
 * next assistant opened the student met "choose a course" over a course that was startable again.
 */
test("an auto-selected draft dropped when its window closed is restored when the next one opens", async () => {
  let closing: number | undefined
  const view = await mount({
    catalogFor: () => {
      closing ??= Date.now() + 800
      return {
        ...catalog(),
        courses: [course("101", ["1", "2"])],
        assistants: [
          assistant("1", "101", { endsAt: new Date(closing).toISOString() }),
          assistant("2", "101", { startsAt: new Date(closing + 800).toISOString() }),
        ],
      }
    },
  })
  try {
    await until(() => view.jolli.draft.value?.assistantId === "1")
    await until(() => view.jolli.draft.value === undefined, 3000)
    await until(() => view.jolli.draft.value?.assistantId === "2", 3000)
  } finally {
    view.close()
  }
}, 10000)
