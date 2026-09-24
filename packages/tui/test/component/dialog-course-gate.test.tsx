/** @jsxImportSource @opentui/solid */
import { afterAll, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
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
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { DialogCourseGate } from "../../src/component/dialog-course-gate"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/**
 * ⚠ THE LOCKDOWN FLAG IS SET BY THE SHIPPED ENTRY POINT, NOT BY THE LIBRARY, so a test process has
 * it off and every gate this file exercises would silently answer "nothing to see". `Flag` reads
 * the environment at access time, which is what makes setting it here enough.
 */
const originalLockdown = process.env["JOLLICODE_LOCKDOWN"]
process.env["JOLLICODE_LOCKDOWN"] = "1"
afterAll(() => {
  if (originalLockdown === undefined) delete process.env["JOLLICODE_LOCKDOWN"]
  else process.env["JOLLICODE_LOCKDOWN"] = originalLockdown
})

const course = (id: string, entryState: string, assistantIds: string[]) => ({
  id,
  code: `CS ${id}`,
  title: "A course",
  kind: "code",
  accent: 1,
  assistantIds,
  status: entryState === "draft" ? "draft" : "published",
  entryState,
  endsOn: null,
})

const assistant = {
  id: "1",
  courseId: "101",
  name: "Tutor",
  kind: "code",
  blurb: "",
  icon: "Sparkles",
  accent: 1,
  isDefault: true,
  instructions: "",
  allowedModelIds: [],
  guardrails: { neverGiveDirectAnswers: false, restrictToMaterials: false, showCitations: false, weeklyTokenCap: 0 },
  coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
  skills: [],
  status: "live",
}

/** Nothing startable, then everything — the shape of signing back in after a sign-out. */
const NOTHING = { status: "ok", courses: [course("202", "draft", [])], assistants: [], modelTiers: {} }
const EVERYTHING = { status: "ok", courses: [course("101", "open", ["1"])], assistants: [assistant], modelTiers: {} }

async function mount() {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  let answers = 0
  const calls = createFetch((url) => {
    /**
     * ⚠ THE CREDENTIAL IS PRESENT THROUGHOUT, because "are there courses" is only a question once
     * somebody is signed in — `noCourses()` checks that first, and a signed-out empty list means
     * "sign in", not "your instructor has not set one up".
     */
    if (url.pathname === "/provider")
      return Promise.resolve(json({ all: [], default: {}, connected: [providerIdFor("anthropic")] }))
    if (url.pathname !== "/jolli/course") return undefined
    answers += 1
    return Promise.resolve(json(answers === 1 ? NOTHING : EVERYTHING))
  })
  const config = createTuiResolvedConfig()

  let jolli!: ReturnType<typeof useJolli>
  let dialog!: ReturnType<typeof useDialog>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const captured = { jolli: useJolli(), dialog: useDialog() }
    onMount(() => {
      jolli = captured.jolli
      dialog = captured.dialog
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

  const app = await testRender(() => <Harness />, { width: 100, height: 26 })
  await ready
  await app.waitFor(() => jolli.loaded())
  await app.renderOnce()
  return {
    app,
    tmp,
    get jolli() {
      return jolli
    },
    get dialog() {
      return dialog
    },
  }
}

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/**
 * ⚠ THE CATALOGUE IS ALLOWED TO RESOLVE LATE, AND A DIALOG IS NOT A VIEW OF A CONDITION. Signing
 * out clears the cached catalogue, so signing back in fetches cold — there is a real window where
 * the student holds a credential and has no courses yet. The gate opens in that window, and if it
 * does not close itself the answer that arrives afterwards leaves it contradicting the composer
 * behind it, which by then has bound a course and picked a model.
 */
test("closes itself once the courses arrive", async () => {
  const picker = await mount()
  try {
    expect(picker.jolli.noCourses()).toBe(true)

    picker.dialog.replace(() => <DialogCourseGate />)
    await wait(() => picker.dialog.stack.length === 1)

    // The catalogue answers again — the second fetch is the one that has the courses.
    picker.jolli.refresh()

    await wait(() => picker.dialog.stack.length === 0)
    expect(picker.jolli.noCourses()).toBe(false)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})
