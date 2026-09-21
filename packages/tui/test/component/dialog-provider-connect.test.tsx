/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { Brand } from "@opencode-ai/core/brand"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider as DialogProviderConnect } from "../../src/component/dialog-provider"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

/**
 * ⚠ THE AUTH METHODS ARRIVE AFTER THE PICKER DOES, WHICH IS THE WHOLE POINT OF THIS FILE.
 * `provider_auth` is fetched in the bootstrap's non-blocking second pass, so `/connect`, the model
 * dialog and the composer can all open this picker while the store still says there is nothing to
 * sign in to. Holding `/provider/auth` open reproduces that window exactly, rather than
 * approximating it with a timer.
 */
async function mountPicker(methods: Promise<Response>, options: { confirm?: boolean } = {}) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  /**
   * ⚠ REACHING `/provider/{id}/oauth/authorize` IS THE OBSERVABLE "A BROWSER IS ABOUT TO OPEN". The
   * launch itself happens in `AutoMethod`'s `onMount`, one step after this request answers — so
   * answering with a body that names no method stops the flow dead while still recording that the
   * attempt was made. Nothing is stubbed that the product does not already call.
   */
  const authorized: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/provider/auth") return methods
    if (url.pathname.endsWith("/oauth/authorize")) {
      authorized.push(url.pathname)
      return Promise.resolve(json({}))
    }
    return undefined
  })
  const config = createTuiResolvedConfig()

  let sync!: ReturnType<typeof useSync>
  let dialog!: ReturnType<typeof useDialog>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })

  function Probe() {
    const captured = { sync: useSync(), dialog: useDialog() }
    onMount(() => {
      sync = captured.sync
      dialog = captured.dialog
      mounted()
    })
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    // The dialog stack rides on the opencode mode layer, so this has to run before anything under
    // it renders — `onMount` would be too late for the provider it is registered for.
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <ClipboardProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider>
              <KVProvider>
                <ToastProvider>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                      <PermissionProvider>
                        <ProjectProvider>
                          <ExitProvider exit={() => {}}>
                            <SyncProvider>
                              <ThemeProvider mode="dark">
                                <DialogProvider>
                                  <Probe />
                                  <DialogProviderConnect confirm={options.confirm} />
                                </DialogProvider>
                              </ThemeProvider>
                            </SyncProvider>
                          </ExitProvider>
                        </ProjectProvider>
                      </PermissionProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  await ready
  return {
    app,
    tmp,
    authorized,
    get sync() {
      return sync
    },
    get dialog() {
      return dialog
    },
  }
}

/**
 * ⚠ A WALL-CLOCK WAIT, NOT `app.waitFor`. That one gives up after 20 render passes, which elapse
 * long before an effect that has to await a fetch settles — the same reason `wait` below exists.
 */
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

test("starts the sign-in once the auth methods land, not only if they were already there", async () => {
  let land!: () => void
  const methods = new Promise<Response>((resolve) => {
    land = () => resolve(json({ [Brand.short]: [{ type: "api", label: "API key" }] }))
  })
  const picker = await mountPicker(methods)

  try {
    // Mounted with the answer still in flight: this is the state that used to be read once and kept.
    expect(picker.sync.data.provider_auth[Brand.short]).toBeUndefined()
    expect(picker.dialog.stack.length).toBe(0)

    land()
    await wait(() => picker.dialog.stack.length === 1)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

test("keeps the login it started when the credential lands", async () => {
  const picker = await mountPicker(Promise.resolve(json({ [Brand.short]: [{ type: "api", label: "API key" }] })))

  try {
    await wait(() => picker.dialog.stack.length === 1)

    // Signing in makes the picker's own action "signed-in". Re-running it would toast and clear the
    // dialog the student is typing their key into, so the decision is latched to its first answer.
    picker.sync.set("provider_next", "connected", [Brand.short])
    await Bun.sleep(50)

    expect(picker.dialog.stack.length).toBe(1)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

const API_METHODS = () => json({ [Brand.short]: [{ type: "oauth", label: "Sign in" }] })

/**
 * ⚠ THE STARTUP OPEN MUST NOT LAUNCH A BROWSER ON ITS OWN. `app.tsx` opens this picker by itself
 * when sync settles with no provider, and under a single-provider lockdown that resolves straight
 * to "log in" — so without a confirmation step, launching `jollicode` put a browser tab on screen
 * in ZERO keystrokes, with no dialog to read and nothing to cancel.
 */
test("an unrequested open asks before it opens a browser", async () => {
  const picker = await mountPicker(Promise.resolve(API_METHODS()), { confirm: true })

  try {
    await waitForText(picker.app, "Press enter to open your browser")
    // The confirmation is up and nothing has been authorized: no browser can have opened.
    expect(picker.authorized).toEqual([])

    picker.app.mockInput.pressEnter()
    await wait(() => picker.authorized.length === 1)
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})

/** ⚠ AND `/connect` IS STILL ONE STEP. The student asked; re-asking would be the picker stalling. */
test("an explicit open goes straight to the browser", async () => {
  const picker = await mountPicker(Promise.resolve(API_METHODS()))

  try {
    await wait(() => picker.authorized.length === 1)
    await picker.app.renderOnce()
    expect(picker.app.captureCharFrame()).not.toContain("Press enter to open your browser")
  } finally {
    picker.app.renderer.destroy()
    await picker.tmp[Symbol.asyncDispose]()
  }
})
