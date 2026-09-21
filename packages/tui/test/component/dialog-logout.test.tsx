/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { Brand } from "@opencode-ai/core/brand"
import { DialogLogout } from "../../src/component/dialog-logout"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

async function mount(options: { connected: boolean }) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  /**
   * ⚠ THE DELETE IS RECORDED RATHER THAN STUBBED AWAY. `/auth/{providerID}` is the request the
   * product actually makes; answering it is what lets this assert that nothing was removed until
   * the student confirmed.
   */
  const removed: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname.startsWith("/auth/")) {
      removed.push(url.pathname)
      return Promise.resolve(json(true))
    }
    if (url.pathname === "/instance/dispose") return Promise.resolve(json(true))
    /**
     * ⚠ THE CREDENTIAL IS PRESENT FROM THE FIRST BOOTSTRAP, not written in afterwards. A student
     * reaches `/logout` long after sign-in has settled, and mounting into the other state would
     * exercise the "nothing to do" branch and then contradict it.
     */
    if (url.pathname === "/provider")
      return Promise.resolve(json({ all: [], default: {}, connected: options.connected ? [Brand.short] : [] }))
    return undefined
  })
  const config = createTuiResolvedConfig()

  let sync!: ReturnType<typeof useSync>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const captured = useSync()
    onMount(() => {
      sync = captured
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
                                  <DialogProvider>
                                    <Probe />
                                    <DialogLogout />
                                  </DialogProvider>
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
  await app.waitFor(() => sync.status === "complete")
  await app.renderOnce()
  return { app, tmp, removed }
}

async function waitForText(app: Awaited<ReturnType<typeof testRender>>, text: string, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    await app.renderOnce()
    if (app.captureCharFrame().includes(text)) return
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for: ${text}\n${app.captureCharFrame()}`)
    await Bun.sleep(10)
  }
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/**
 * ⚠ SIGNING OUT THROWS AWAY A CREDENTIAL AND THE CACHED COURSE LIST BEHIND IT, so one keystroke
 * must not be enough. `/connect` needs no confirmation because signing in again undoes it.
 */
test("asks before it removes anything", async () => {
  const picker = await mount({ connected: true })
  try {
    await waitForText(picker.app, `Sign out of ${Brand.name}`)
    expect(picker.removed).toEqual([])

    picker.app.mockInput.pressEnter()
    await wait(() => picker.removed.length === 1)
    expect(picker.removed[0]).toBe(`/auth/${Brand.short}`)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/**
 * ⚠ AND IT SAYS SO RATHER THAN OFFERING A CONFIRMATION FOR NOTHING. A dialog asking whether to
 * discard a credential that does not exist reads as though one did.
 */
test("says nothing to do when no credential is held", async () => {
  const picker = await mount({ connected: false })
  try {
    await Bun.sleep(150)
    await picker.app.renderOnce()
    expect(picker.app.captureCharFrame()).not.toContain(`Sign out of ${Brand.name}`)
    expect(picker.removed).toEqual([])
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})
