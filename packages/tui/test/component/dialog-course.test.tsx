/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { Brand } from "@opencode-ai/core/brand"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { JolliProvider, ModelGrant, useJolli } from "../../src/context/jolli"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
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
 * and grants are `jolli/<uuid>`.
 */
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
      chatSharing: "private",
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
      chatSharing: "private",
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
      chatSharing: "private",
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
      chatSharing: "private",
    },
  ],
  assistants: [
    {
      id: "1",
      courseId: "101",
      name: "Tutor",
      kind: "code",
      blurb: "Works through problems with you",
      accent: 1,
      isDefault: true,
      instructions: "",
      allowedModelIds: ["jolli/opus"],
      modelId: "jolli/opus",
      guardrails: { neverGiveDirectAnswers: true, restrictToMaterials: false, showCitations: true, weeklyTokenCap: 0 },
      coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
      skills: [],
      status: "live",
    },
  ],
  modelTiers: {},
}

async function mount() {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/jolli/course") return Promise.resolve(json(CATALOG))
    /**
     * ⚠ SIGNED IN THROUGHOUT, because a course is only ever shown to somebody who is. The context
     * checks the credential before it restores or pre-selects anything, so a harness that left this
     * empty would exercise the signed-out branch and prove nothing about the picker.
     */
    if (url.pathname === "/provider") return Promise.resolve(json({ all: [], default: {}, connected: [Brand.short] }))
    return undefined
  })
  const config = createTuiResolvedConfig()

  let jolli!: ReturnType<typeof useJolli>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const captured = useJolli()
    onMount(() => {
      jolli = captured
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
                    <RouteProvider initialRoute={{ type: "home" }}>
                      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={() => {}}>
                              <SyncProvider>
                                <ThemeProvider mode="dark">
                                  <JolliProvider>
                                    <DialogProvider>
                                      <Probe />
                                      <DialogCourse />
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
      sharing: { staff: false, everyone: false },
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

    expect(ModelGrant.allowed()).toEqual(["jolli/opus"])
    expect(ModelGrant.preferred()).toBe("jolli/opus")

    expect(ModelGrant.isAllowed("jolli", "opus")).toBe(true)
    expect(ModelGrant.isAllowed("jolli", "sonnet")).toBe(false)
    expect(ModelGrant.isAllowed("jolli", "haiku")).toBe(false)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})
