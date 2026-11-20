/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("selects the first choice again after a filter that matched nothing is cleared", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const selected: string[] = []
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })
  function OpenDialog() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogSelect
          title="Themes"
          options={[
            { title: "Aura", value: "aura" },
            { title: "Nord", value: "nord" },
          ]}
          onSelect={(option) => selected.push(option.value)}
        />
      )),
    )
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    onMount(mounted)
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <OpenDialog />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 24, kittyKeyboard: true })
  await ready
  try {
    // The filter input takes focus a tick after it mounts.
    await Bun.sleep(50)
    await app.mockInput.typeText("zzz")
    await Bun.sleep(10)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Aura")
    // Delete one key at a time, as a person does, so each filter's own reset runs before the next.
    for (const _ of "zzz") {
      app.mockInput.pressBackspace()
      await Bun.sleep(10)
    }
    await app.renderOnce()
    app.mockInput.pressEnter()
    expect(selected).toEqual(["aura"])
  } finally {
    app.renderer.destroy()
  }
})
