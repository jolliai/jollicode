/** @jsxImportSource @opentui/solid */
/**
 * THE COURSE A STUDENT ALREADY CHOSE, AND THE THREE WAYS IT USED TO BE THROWN AWAY.
 *
 * ⚠ EVERY CASE HERE NEEDS TWO STARTABLE COURSES, WHICH IS WHAT `dialog-course.test.tsx` DELIBERATELY
 * DOES NOT HAVE. With one, the auto-select branch binds it and nothing about remembering is
 * exercised — the student is never asked in the first place, so a memory that never persisted would
 * pass every assertion in that file. Two is the smallest catalogue where "do not ask me again" is a
 * claim with content.
 *
 * ⚠ AND THEY ASSERT ON `needsChoice()` RATHER THAN ON A RENDERED FRAME. That predicate is the whole
 * of what `app.tsx` turns into the picker opening by itself (see `needsCourseChoice`), so it is the
 * thing the student experiences as being interrupted; the dialog's own rendering is already covered
 * where the dialog is.
 */
import { afterAll, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createEffect, on, onCleanup, onMount } from "solid-js"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
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

/**
 * ⚠ THE LOCKDOWN FLAG IS SET BY THE SHIPPED ENTRY POINT, NOT BY THE LIBRARY, so a test process has
 * it off and `needsChoice()` — the whole subject of this file — answers false unconditionally.
 * `Flag` reads the environment at access time, which is what makes setting it here enough.
 */
const originalLockdown = process.env["JOLLICODE_LOCKDOWN"]
process.env["JOLLICODE_LOCKDOWN"] = "1"
afterAll(() => {
  if (originalLockdown === undefined) delete process.env["JOLLICODE_LOCKDOWN"]
  else process.env["JOLLICODE_LOCKDOWN"] = originalLockdown
})

/** ⚠ `Flock` REFUSES UNTIL A STATE DIRECTORY IS SET, and importing `Global` is what sets it. */
void Global.Path.state

const PROVIDER_ID = providerIdFor("anthropic")
const MODEL_KEY = `${PROVIDER_ID}/opus`

function course(id: string, code: string, assistantIds: string[], entryState = "open") {
  return {
    id,
    code,
    title: code,
    kind: "code",
    accent: 1,
    assistantIds,
    status: "published",
    entryState,
    endsOn: null,
  }
}

function assistant(id: string, courseId: string, name: string, isDefault = false) {
  return {
    id,
    courseId,
    name,
    kind: "code",
    blurb: "",
    accent: 1,
    isDefault,
    instructions: "",
    allowedModelIds: [MODEL_KEY],
    modelId: MODEL_KEY,
    guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
    coaching: { coachTheQuestion: false, coachTheProcess: false, coachTheModelChoice: false, instructions: "" },
    skills: [],
    status: "live",
  }
}

/** Startable courses, so every binding below is a decision somebody had to make. */
const CATALOG = {
  status: "ok",
  courses: [course("101", "CS 101", ["1", "2"]), course("303", "ART 303", ["3"]), course("404", "MATH 404", ["4"])],
  assistants: [
    assistant("1", "101", "Tutor", true),
    assistant("2", "101", "Grader"),
    assistant("3", "303", "Studio", true),
    assistant("4", "404", "Prover", true),
  ],
  modelTiers: {},
}

/**
 * The same catalogue after CS 101 has ended — still enrolled, no longer startable.
 *
 * ⚠ TWO COURSES ARE LEFT STANDING ON PURPOSE. Drop to one and the auto-select branch binds it,
 * which is correct behaviour and would quietly answer every assertion below about being asked.
 */
const CATALOG_ENDED = {
  ...CATALOG,
  courses: [
    course("101", "CS 101", ["1", "2"], "ended"),
    course("303", "ART 303", ["3"]),
    course("404", "MATH 404", ["4"]),
  ],
}

/** The same student after CS 101 dropped off their enrolment entirely — no row, not a blocked one. */
const CATALOG_UNENROLLED = {
  ...CATALOG,
  courses: [course("303", "ART 303", ["3"]), course("404", "MATH 404", ["4"])],
}

const SESSION_ID = "ses_resumed"

function boundSession(binding: { courseId: string; assistantId: string }) {
  return {
    id: SESSION_ID,
    title: "resumed",
    time: { created: 0, updated: 0 },
    version: "1.14.42",
    directory,
    project_id: "proj_test",
    metadata: { jolli: binding },
  }
}

/**
 * ⚠ `state` IS PASSED IN SO A TEST CAN MOUNT TWICE OVER ONE DIRECTORY, which is the only way to
 * write "relaunch" in this harness: `kv.json` is the whole of what survives a process.
 */
async function mount(
  options: {
    state?: string
    route?: Route
    sessions?: unknown[]
    account?: string
    catalog?: unknown
  } = {},
) {
  const state = options.state ?? (await tmpdir()).path
  if (!options.state) await Bun.write(`${state}/kv.json`, "{}")
  const events = createEventSource()
  const auth = { connected: true }
  const identity: { account: string } = { account: options.account ?? "student-a" }
  const catalog = options.catalog ?? CATALOG
  const calls = createFetch((url) => {
    if (url.pathname === "/jolli/course")
      return Promise.resolve(
        json(auth.connected ? { ...(catalog as object), ...identity } : { ...(catalog as object) }),
      )
    if (url.pathname === "/provider")
      return Promise.resolve(json({ all: [], default: {}, connected: auth.connected ? [PROVIDER_ID] : [] }))
    if (url.pathname === "/session") return Promise.resolve(json(options.sessions ?? []))
    return undefined
  })
  const config = createTuiResolvedConfig()

  let jolli!: ReturnType<typeof useJolli>
  let route!: ReturnType<typeof useRoute>
  /** Whether the picker was ever wanted during this launch, at any instant — see `Probe`. */
  let asked = false
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  /**
   * ⚠ IT WATCHES `needsChoice()` THE WAY `app.tsx` DOES RATHER THAN SAMPLING IT AFTERWARDS, because
   * the failure this catches lasted one millisecond. A test that mounts, waits for everything to
   * settle and then asks "does it want me to choose?" gets `false` from a launch that had already
   * thrown the picker up and left it there — `DialogCourse` captures its reason for existing at
   * mount and does not take itself back. The only faithful observer is a standing effect.
   */
  function Probe() {
    const captured = useJolli()
    const capturedRoute = useRoute()
    createEffect(
      on(
        () => captured.needsChoice(),
        (needed) => {
          if (needed) asked = true
        },
      ),
    )
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
    get jolli() {
      return jolli
    },
    get route() {
      return route
    },
    /** True if `needsChoice()` was true at ANY point since mount, not just when asked. */
    get asked() {
      return asked
    },
    /**
     * Sign in as somebody else WITHOUT the connected set ever going empty — the switch that happens
     * between two of `sync.tsx`'s ten-second polls, or in another surface sharing the credential DB.
     */
    switchAccount(value: string) {
      identity.account = value
      jolli.refresh()
    },
    /** Flip the credential and make sync re-read it, as its own poll would ten seconds later. */
    setConnected(value: boolean) {
      auth.connected = value
      events.emit({
        directory,
        project: "proj_test",
        payload: { id: "evt_disposed", type: "server.instance.disposed", properties: { directory } },
      })
    },
    close() {
      app.renderer.destroy()
    },
  }
}

/** Waits on the clock, not render passes: a sign-in change is a bootstrap round-trip away. */
async function until(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/** kv writes are queued behind a file lock, so the next mount has to see them land. */
async function settled(app: Awaited<ReturnType<typeof mount>>["app"]) {
  await app.renderOnce()
  await Bun.sleep(50)
}

/**
 * THE LAUNCH RACE THAT IS NOT ONE, AND THE STRUCTURE THAT DECIDES IT.
 *
 * ⚠ TWO ANSWERS ARRIVE INDEPENDENTLY AT EVERY LAUNCH AND NOTHING ORDERS THEM: the catalogue over
 * HTTP, usually off a warm snapshot, and the remembered course off disk behind `Flock`, whose
 * backoff starts at 100ms. If the catalogue could land first, there would be a window with a signed-in
 * student, several startable courses and no binding — the exact shape that opens the picker, which
 * does not close itself when the answer arrives a moment later.
 *
 * ⚠ WHAT RULES IT OUT IS THAT `KVProvider` GATES ITS CHILDREN ON `ready`, so the Jolli context does
 * not exist — and its fetch has not been made — until the disk has answered. That is load-bearing and
 * invisible: it lives in another file, in a context helper, and would be undone by mounting the Jolli
 * provider above the KV one or by dropping the flag from KV's interface. This case holds the lock so
 * the disk cannot answer, and pins that NOTHING below it comes up in the meantime.
 */
test("nothing is decided until the remembered course has been read off disk", async () => {
  const first = await mount()
  first.jolli.draft.setCourse("303")
  await settled(first.app)
  first.close()

  const lease = await Flock.acquire(`tui-kv:${path.join(first.state, "kv.json")}`)
  let mounted = false
  const pending = mount({ state: first.state }).then((value) => {
    mounted = true
    return value
  })
  await Bun.sleep(250)
  expect(mounted).toBe(false)

  await lease.release()
  const second = await pending
  try {
    expect(second.jolli.course()?.id).toBe("303")
    expect(second.jolli.needsChoice()).toBe(false)
  } finally {
    second.close()
  }
})

/**
 * ⚠ THE BASELINE THE OTHER CASES ARE MEASURED AGAINST. Two startable courses and nothing on disk is
 * the one state where interrupting the student is right.
 */
test("asks the first time, with nothing remembered and a real choice to make", async () => {
  const first = await mount()
  try {
    expect(first.jolli.current()).toBeUndefined()
    expect(first.jolli.needsChoice()).toBe(true)
  } finally {
    first.close()
  }
})

/**
 * ⚠ `asked` IS THE ASSERTION THAT MATTERS AND `needsChoice()` AT THE END IS NOT. The launch that
 * shipped restored the course correctly and still put the picker up, because the catalogue landing
 * and the memory being read are two events in that order — for one millisecond there was a signed-in
 * student with several startable courses and no binding, which is all `app.tsx` needs to open a
 * dialog that then has no reason to close. Sampling afterwards sees the tidy end state and passes.
 */
test("a course chosen once is restored on the next launch, unasked", async () => {
  const first = await mount()
  first.jolli.draft.setCourse("303")
  await settled(first.app)
  first.close()

  const second = await mount({ state: first.state })
  try {
    await second.app.waitFor(() => !!second.jolli.course())
    expect(second.jolli.course()?.id).toBe("303")
    expect(second.jolli.assistant()?.name).toBe("Studio")
    expect(second.jolli.needsChoice()).toBe(false)
    expect(second.asked).toBe(false)
  } finally {
    second.close()
  }
})

/**
 * ⚠ THE REGRESSION. Signing out used to delete the remembered course outright, on the argument that
 * the button reaching it says "use a different account" — so a renewal that lapsed overnight, or a
 * student signing back in as themselves, was met by the picker every single time. Filing per account
 * is what lets this survive; the case below is what stops that from becoming a leak.
 */
test("signing out and back in as the same student keeps their course", async () => {
  const picker = await mount()
  try {
    picker.jolli.draft.setCourse("303")
    await settled(picker.app)

    picker.setConnected(false)
    await until(() => !picker.jolli.signedIn() && !picker.jolli.current())

    picker.setConnected(true)
    await until(() => !!picker.jolli.course())
    expect(picker.jolli.course()?.id).toBe("303")
    expect(picker.jolli.needsChoice()).toBe(false)
  } finally {
    picker.close()
  }
})

/**
 * SIGNING IN AS SOMEBODY ELSE WITHOUT THE PROCESS RESTARTING.
 *
 * ⚠ THE SWITCH NEED NOT BE SEEN AS A SIGN-OUT, AND KEYING EVERYTHING OFF ONE WAS THE BUG. `signedIn`
 * comes off a ten-second poll of the connected set, so "use a different account" — a sign-out and a
 * sign-in, seconds apart — can land entirely between two samples. Nothing observed the gap, the
 * latches stayed shut, and the new student got the previous one's course with no picker at all.
 */
test("switching account drops the previous student's course and asks", async () => {
  const picker = await mount({ account: "student-a" })
  try {
    picker.jolli.draft.setCourse("303")
    await settled(picker.app)
    expect(picker.jolli.course()?.id).toBe("303")

    picker.switchAccount("student-b")
    await until(() => picker.jolli.needsChoice())

    expect(picker.jolli.current()).toBeUndefined()
  } finally {
    picker.close()
  }
})

/** ⚠ AND THE NEW STUDENT GETS THEIR OWN ANSWER, not the picker, when they have one on this machine. */
test("switching to an account with its own remembered course restores that one", async () => {
  const first = await mount({ account: "student-b" })
  first.jolli.draft.setCourse("404")
  await settled(first.app)
  first.close()

  const second = await mount({ state: first.state, account: "student-a" })
  try {
    second.jolli.draft.setCourse("303")
    await settled(second.app)
    expect(second.jolli.course()?.id).toBe("303")

    second.switchAccount("student-b")
    await until(() => second.jolli.course()?.id === "404")

    expect(second.jolli.assistant()?.name).toBe("Prover")
  } finally {
    second.close()
  }
})

test("a different student on the same machine inherits nothing", async () => {
  const first = await mount({ account: "student-a" })
  first.jolli.draft.setCourse("303")
  await settled(first.app)
  first.close()

  const second = await mount({ state: first.state, account: "student-b" })
  try {
    expect(second.jolli.current()).toBeUndefined()
    expect(second.jolli.needsChoice()).toBe(true)
  } finally {
    second.close()
  }
})

/**
 * ⚠ THE OTHER REGRESSION, AND THE ONE NO DRAFT-SIDE TEST COULD HAVE CAUGHT. A draft composed in this
 * process survives `/new` on its own — `promote` leaves it alone deliberately — but a RESUMED session
 * never had one, because the restore effect stands down while there is a session id. Pressing `/new`
 * from a resumed session therefore landed on an unbound composer with several startable courses,
 * which is exactly what opens the picker.
 */
test("/new after a resumed session starts in that session's course", async () => {
  const picker = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [boundSession({ courseId: "101", assistantId: "2" })],
  })
  try {
    await picker.app.waitFor(() => picker.jolli.course()?.id === "101")
    expect(picker.jolli.locked()).toBe(true)

    picker.route.navigate({ type: "home" })
    await picker.app.waitFor(() => !picker.jolli.locked())

    expect(picker.jolli.course()?.id).toBe("101")
    expect(picker.jolli.assistant()?.id).toBe("2")
    expect(picker.jolli.needsChoice()).toBe(false)
  } finally {
    picker.close()
  }
})

/** And it outlives the process, so the next launch opens in the course they were last working in. */
test("the course of a resumed session is what the next launch restores", async () => {
  const first = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [boundSession({ courseId: "303", assistantId: "3" })],
  })
  await first.app.waitFor(() => first.jolli.course()?.id === "303")
  await settled(first.app)
  first.close()

  const second = await mount({ state: first.state })
  try {
    await second.app.waitFor(() => !!second.jolli.course())
    expect(second.jolli.course()?.id).toBe("303")
    expect(second.jolli.needsChoice()).toBe(false)
  } finally {
    second.close()
  }
})

/**
 * ⚠ REMEMBERED IS NOT TRUSTED, IT IS RE-RESOLVED. Term ends, a professor unpublishes, an assistant
 * is retired — the stored id stops naming something a session may start in, and the student has to
 * be asked again rather than silently staged into a course the server is about to refuse.
 */
test("a remembered course that can no longer be started sends the student back to the picker", async () => {
  const first = await mount()
  first.jolli.draft.setCourse("101")
  await settled(first.app)
  first.close()

  const second = await mount({ state: first.state, catalog: CATALOG_ENDED })
  try {
    expect(second.jolli.current()).toBeUndefined()
    expect(second.jolli.needsChoice()).toBe(true)
  } finally {
    second.close()
  }
})

/**
 * ⚠ AND GONE FROM THE LIST IS NOT THE SAME SHAPE AS BLOCKED IN IT. An ended course still has a row
 * to fail `canStartSession` against; an unenrolment leaves the id naming nothing at all, which is a
 * different branch — `draftFor` cannot resolve the course, so there is no assistant to default and
 * no sharing rule to compute. Both have to end with the student being asked.
 *
 * ⚠ THE STALE ENTRY IS LEFT ON DISK RATHER THAN PRUNED, DELIBERATELY. "Not in the catalogue" and
 * "the catalogue did not arrive" are the same empty list from here, and deleting on the second
 * would cost a student their course for launching on a train.
 */
test("a remembered course that is no longer in the catalogue sends the student back to the picker", async () => {
  const first = await mount()
  first.jolli.draft.setCourse("101")
  await settled(first.app)
  first.close()

  const second = await mount({ state: first.state, catalog: CATALOG_UNENROLLED })
  try {
    expect(second.jolli.current()).toBeUndefined()
    expect(second.jolli.needsChoice()).toBe(true)
  } finally {
    second.close()
  }
})

/**
 * ⚠ AND A SESSION'S OWN BINDING IS STILL ITS OWN. HIST-style courses outlive their term: the
 * transcript belongs to the course it was written under and `/course` says so, but nothing about
 * reading it may stage an ended course for the session that has not been created yet.
 */
test("an ended course is shown in its session and not carried into the next one", async () => {
  const picker = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [boundSession({ courseId: "101", assistantId: "1" })],
    catalog: CATALOG_ENDED,
  })
  try {
    await picker.app.waitFor(() => picker.jolli.course()?.id === "101")

    picker.route.navigate({ type: "home" })
    await picker.app.waitFor(() => !picker.jolli.locked())

    expect(picker.jolli.current()).toBeUndefined()
    expect(picker.jolli.needsChoice()).toBe(true)
  } finally {
    picker.close()
  }
})
