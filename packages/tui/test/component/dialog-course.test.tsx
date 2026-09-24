/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { JolliProvider, ModelGrant, useJolli } from "../../src/context/jolli"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider, useRoute, type Route } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { DialogAssistant } from "../../src/component/dialog-assistant"
import { DialogCourse } from "../../src/component/dialog-course"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/**
 * THE CATALOGUE AS `/jolli/course` ANSWERS IT — one course per state the picker has a sentence for.
 *
 * ⚠ THE SHAPE IS THE SERVER'S OUTPUT, NOT THE GATEWAY'S WIRE FORMAT. `projectCatalog` has already
 * run by the time a renderer sees this: ids are strings, `entryState` is computed against today,
 * and grants are `<provider-id>/<uuid>`.
 */
const PROVIDER_ID = providerIdFor("anthropic")
const MODEL_KEY = `${PROVIDER_ID}/opus`

const CATALOG = {
  status: "ok",
  courses: [
    {
      id: "101",
      code: "CS 101",
      title: "Intro to Programming",
      kind: "code",
      accent: 1,
      assistantIds: ["1"],
      status: "published",
      entryState: "open",
      endsOn: null,
        },
    {
      id: "202",
      code: "MATH 202",
      title: "Linear Algebra",
      kind: "code",
      accent: 2,
      assistantIds: [],
      status: "draft",
      entryState: "draft",
      endsOn: null,
        },
    {
      id: "303",
      code: "ART 303",
      title: "Generative Art",
      kind: "code",
      accent: 3,
      assistantIds: [],
      status: "published",
      entryState: "open",
      endsOn: null,
        },
    {
      id: "404",
      code: "HIST 404",
      title: "Last Term",
      kind: "code",
      accent: 4,
      assistantIds: [],
      status: "published",
      entryState: "ended",
      endsOn: "2020-01-01",
        },
  ],
  assistants: [
    {
      id: "1",
      courseId: "101",
      name: "Tutor",
      kind: "code",
      blurb: "Works through problems with you",
      icon: "Sparkles",
      accent: 1,
      isDefault: true,
      instructions: "",
      allowedModelIds: [MODEL_KEY],
      modelId: MODEL_KEY,
      guardrails: { neverGiveDirectAnswers: true, restrictToMaterials: false, showCitations: true, weeklyTokenCap: 0 },
      coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
      skills: [],
      status: "live",
    },
    {
      id: "2",
      courseId: "101",
      name: "Grader",
      kind: "code",
      blurb: "Checks your submission",
      accent: 1,
      isDefault: false,
      instructions: "",
      allowedModelIds: [MODEL_KEY],
      modelId: MODEL_KEY,
      guardrails: { neverGiveDirectAnswers: true, restrictToMaterials: false, showCitations: true, weeklyTokenCap: 0 },
      coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
      skills: [],
      status: "live",
    },
  ],
  modelTiers: {},
}

const SESSION_ID = "ses_bound"

/** Waits on the clock, not render passes: a sign-in change is a bootstrap round-trip away. */
async function until(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/** A session as `/session` lists it, carrying the binding `session.create` wrote into its metadata. */
function boundSession(binding: { courseId: string; assistantId: string }) {
  return {
    id: SESSION_ID,
    title: "bound",
    time: { created: 0, updated: 0 },
    version: "1.14.42",
    directory,
    project_id: "proj_test",
    metadata: { jolli: binding },
  }
}

/**
 * `dialog` is what renders in place, outside the dialog stack; pass `null` to render nothing and
 * open dialogs through `picker.dialog` the way `app.tsx` does.
 */
async function mount(options: { route?: Route; sessions?: unknown[]; dialog?: (() => JSX.Element) | null } = {}) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const auth = { connected: true }
  const calls = createFetch((url) => {
    if (url.pathname === "/jolli/course") return Promise.resolve(json(CATALOG))
    /**
     * ⚠ SIGNED IN THROUGHOUT, because a course is only ever shown to somebody who is. The context
     * checks the credential before it restores or pre-selects anything, so a harness that left this
     * empty would exercise the signed-out branch and prove nothing about the picker.
     */
    if (url.pathname === "/provider")
      return Promise.resolve(json({ all: [], default: {}, connected: auth.connected ? [PROVIDER_ID] : [] }))
    if (url.pathname === "/session") return Promise.resolve(json(options.sessions ?? []))
    return undefined
  })
  const config = createTuiResolvedConfig()

  let jolli!: ReturnType<typeof useJolli>
  let route!: ReturnType<typeof useRoute>
  let dialog!: ReturnType<typeof useDialog>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const captured = useJolli()
    const capturedRoute = useRoute()
    const capturedDialog = useDialog()
    onMount(() => {
      jolli = captured
      route = capturedRoute
      dialog = capturedDialog
      mounted()
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
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
                                      {options.dialog === undefined ? <DialogCourse /> : options.dialog?.()}
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
    tmp,
    get jolli() {
      return jolli
    },
    get route() {
      return route
    },
    get dialog() {
      return dialog
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
  }
}

/**
 * ⚠ WHAT CANNOT BE CHOSEN IS NOT LISTED. A terminal row has no second column and no disabled
 * styling to carry "your instructor hasn't published this yet", so a row that could only be
 * pressed and refused is left out; `DialogCourseGate` says the one sentence instead, keyed on the
 * same startable set so the two cannot disagree.
 */
test("lists only the courses a session can actually start in", async () => {
  const picker = await mount()
  try {
    const frame = picker.app.captureCharFrame()

    expect(frame).toContain("CS 101")
    expect(frame).toContain("Intro to Programming")

    // Draft, ended, and published-with-no-assistant are absent rather than refused in place.
    expect(frame).not.toContain("MATH 202")
    expect(frame).not.toContain("ART 303")
    expect(frame).not.toContain("HIST 404")

    expect(picker.jolli.canStart("101")).toBe(true)
    expect(picker.jolli.canStart("303")).toBe(false)
    expect(picker.jolli.courses().map((item) => item.id)).toEqual(["101"])
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/**
 * ⚠ ONE STARTABLE COURSE IS NOT A CHOICE. This surface refuses the first prompt until something is
 * bound, so leaving a single-course student unbound would make them meet a refusal and then click
 * the only row on the menu. Picking the course picks its default assistant with it.
 */
test("pre-selects the only startable course, and its default assistant with it", async () => {
  const picker = await mount()
  try {
    await picker.app.waitFor(() => !!picker.jolli.course())
    expect(picker.jolli.course()?.code).toBe("CS 101")
    expect(picker.jolli.assistant()?.name).toBe("Tutor")
    expect(picker.jolli.blocked()).toBeUndefined()

    // The binding that `session.create` will carry.
    expect(picker.jolli.current()).toEqual({
      courseId: "101",
      assistantId: "1",
    })
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/**
 * THE GRANT REACHES THE SIGNAL BOTH READERS SHARE.
 *
 * ⚠ THIS IS THE SEAM, NOT A RESTATEMENT OF `Lookup.isModelAllowed`. That function is tested on its
 * own in core; what can only be checked with the context mounted is that choosing a course
 * publishes the chosen assistant's grant — `context/local.tsx`'s `isModelValid` and the model
 * dialog's filter both read this signal and nothing else.
 */
test("publishes the bound assistant's model grant", async () => {
  const picker = await mount()
  try {
    await picker.app.waitFor(() => !!picker.jolli.assistant())

    expect(ModelGrant.allowed()).toEqual([MODEL_KEY])
    expect(ModelGrant.preferred()).toBe(MODEL_KEY)

    expect(ModelGrant.isAllowed(PROVIDER_ID, "opus")).toBe(true)
    expect(ModelGrant.isAllowed(PROVIDER_ID, "sonnet")).toBe(false)
    expect(ModelGrant.isAllowed(PROVIDER_ID, "haiku")).toBe(false)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/**
 * ⚠ A STARTED SESSION'S PICKER IS A VIEW OF ITS BINDING, NOT THE CATALOGUE WITH ONE ROW MARKED.
 * HIST 404 has ended and is not startable, so it is in no list — yet a transcript written under it
 * is still that course's, and `/course` must say so.
 */
test("a started session lists only its own course, even one that can no longer be started", async () => {
  const picker = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [boundSession({ courseId: "404", assistantId: "1" })],
  })
  try {
    await picker.app.waitFor(() => picker.jolli.course()?.id === "404")
    await picker.app.renderOnce()
    const frame = picker.app.captureCharFrame()

    expect(picker.jolli.locked()).toBe(true)
    expect(frame).toContain("Course (fixed for this session)")
    expect(frame).toContain("HIST 404")
    expect(frame).not.toContain("CS 101")
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

test("a started session lists only its own assistant", async () => {
  const picker = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [boundSession({ courseId: "101", assistantId: "2" })],
    dialog: () => <DialogAssistant />,
  })
  try {
    await picker.app.waitFor(() => picker.jolli.assistant()?.id === "2")
    await picker.app.renderOnce()
    const frame = picker.app.captureCharFrame()

    expect(frame).toContain("Assistant (fixed for this session)")
    expect(frame).toContain("Grader")
    expect(frame).not.toContain("Tutor")
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/**
 * ⚠ A PICKER THAT POPPED UP ON THE DRAFT MUST NOT OUTLIVE IT. `app.tsx` opens this on its own and
 * nothing else closes it, so once a session takes over it would sit — already locked — over the
 * conversation, which read as the picker appearing after every message.
 */
test("a picker opened on the draft closes once a session takes over", async () => {
  const picker = await mount({ dialog: null })
  try {
    picker.dialog.replace(() => <DialogCourse />)
    await picker.app.renderOnce()
    expect(picker.dialog.stack.length).toBe(1)

    picker.route.navigate({ type: "session", sessionID: SESSION_ID })
    await picker.app.waitFor(() => picker.dialog.stack.length === 0)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

test("/course inside a session stays open as a read-only view", async () => {
  const picker = await mount({
    route: { type: "session", sessionID: SESSION_ID },
    sessions: [boundSession({ courseId: "101", assistantId: "1" })],
    dialog: null,
  })
  try {
    picker.dialog.replace(() => <DialogCourse />)
    await picker.app.waitFor(() => !!picker.jolli.course())
    await picker.app.renderOnce()
    expect(picker.dialog.stack.length).toBe(1)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/**
 * ⚠ THE PRE-SELECTION FIRES ONCE PER SIGN-IN, NOT ONCE PER PROCESS. Signing out drops the draft;
 * without the latch reopening, a single-course student signing back in would be told to choose
 * a course from a menu of one.
 */
test("signing out and back in pre-selects the only course again", async () => {
  const picker = await mount({ dialog: null })
  try {
    await picker.app.waitFor(() => !!picker.jolli.current())

    picker.setConnected(false)
    await until(() => !picker.jolli.signedIn() && !picker.jolli.current())

    picker.setConnected(true)
    await until(() => picker.jolli.current()?.courseId === "101")
    expect(picker.jolli.blocked()).toBeUndefined()
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})
