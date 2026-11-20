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

const blocker =
  "the required reading about durable assignment access across every student group before starting the final assessment"
const lastBlocker = "Review materials for the final chapter before the concluding quiz"

async function mount(
  root: string,
  selected: string[],
  allDisabled = false,
  longReason = false,
  overflow?: { enabledAt: number },
) {
  await Bun.write(`${root}/kv.json`, "{}")
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })
  function Choices() {
    onMount(mounted)
    return (
      <DialogSelect
        title="Ordered assignment"
        renderFilter={false}
        showDisabled
        options={
          overflow
            ? Array.from({ length: 9 }, (_, index) => ({
                title:
                  index === overflow.enabledAt
                    ? "Only enabled task"
                    : index === 0
                      ? "First optional web task"
                      : index === 8
                        ? "Final waiting task"
                        : `Unavailable task ${index + 1}`,
                description:
                  index === overflow.enabledAt
                    ? "Start this task in Jolli Code"
                    : index < overflow.enabledAt
                      ? "Optional · Do this task on the web"
                      : `Submit ${index === 8 ? lastBlocker : blocker} first`,
                descriptionBelow: true,
                value: index === overflow.enabledAt ? "enabled" : `unavailable-${index}`,
                disabled: index !== overflow.enabledAt,
              }))
            : [
                { title: "Review materials", value: "first", disabled: allDisabled },
                {
                  title: longReason
                    ? "Waiting quiz with a legally long task name that reaches beyond the entire default dialog width"
                    : "Waiting quiz",
                  description: longReason ? `Submit ${blocker} first` : "Submit Review materials first",
                  descriptionBelow: longReason,
                  value: "waiting",
                  disabled: true,
                },
                { title: "Already released coach", value: "last", disabled: allDisabled },
              ]
        }
        onSelect={(option) => selected.push(option.value)}
      />
    )
  }
  function OpenDialog() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <Choices />))
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state: root, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>{longReason || overflow ? <OpenDialog /> : <Choices />}</DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, {
    width: 100,
    height: !overflow && longReason ? 32 : 24,
    kittyKeyboard: true,
  })
  await ready
  return app
}

test("shows a disabled task in sequence and skips it for keyboard and mouse activation", async () => {
  await using tmp = await tmpdir()
  const selected: string[] = []
  const app = await mount(tmp.path, selected)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame.indexOf("Review materials")).toBeLessThan(frame.indexOf("Waiting quiz"))
    expect(frame.indexOf("Waiting quiz")).toBeLessThan(frame.indexOf("Already released coach"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    expect(selected).toEqual(["last"])
    const y = frame.split("\n").findIndex((line) => line.includes("Waiting quiz"))
    expect(y).toBeGreaterThan(0)
    await app.mockMouse.click(8, y)
    expect(selected).toEqual(["last"])
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    expect(selected).toEqual(["last", "first"])
  } finally {
    app.renderer.destroy()
  }
})

test("keeps an entirely waiting list readable and rejects Enter and mouse activation", async () => {
  await using tmp = await tmpdir()
  const selected: string[] = []
  const app = await mount(tmp.path, selected, true)
  try {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("Waiting quiz")
    app.mockInput.pressEnter()
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.mockMouse.click(
      8,
      frame.split("\n").findIndex((line) => line.includes("Waiting quiz")),
    )
    expect(selected).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("wraps an entire waiting reason under a long title in the default 60-column modal", async () => {
  await using tmp = await tmpdir()
  const selected: string[] = []
  const app = await mount(tmp.path, selected, true, true)
  try {
    await app.renderOnce()
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame.replace(/\s+/g, " ")).toContain(`Submit ${blocker} first`)
    expect(frame).toContain("Already released coach")
    app.mockInput.pressEnter()
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    const y = frame.split("\n").findIndex((line) => line.includes("Submit the required reading"))
    expect(y).toBeGreaterThan(0)
    await app.mockMouse.click(30, y)
    expect(selected).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test.each([0, 4, 8])("reads mixed modal edges with its only enabled task at %s", async (enabledAt) => {
  await using tmp = await tmpdir()
  const selected: string[] = []
  const app = await mount(tmp.path, selected, false, false, { enabledAt })
  const firstTitle = enabledAt === 0 ? "Only enabled task" : "First optional web task"
  const finalTitle = enabledAt === 8 ? "Only enabled task" : "Final waiting task"
  const finalReason = enabledAt === 8 ? "Start this task in Jolli Code" : `Submit ${lastBlocker} first`
  try {
    await app.renderOnce()
    await app.renderOnce()

    // Scanning back to the same enabled task enters reading, without leaving it ready to activate.
    app.mockInput.pressArrow(enabledAt === 0 ? "down" : "up")
    app.mockInput.pressEnter()
    expect(selected).toEqual([])

    app.mockInput.pressKey("HOME")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(firstTitle)
    app.mockInput.pressEnter()
    expect(selected).toEqual([])
    for (let page = 0; page < 2; page++) {
      app.mockInput.pressKey("\x1b[5~")
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain(firstTitle)
      app.mockInput.pressEnter()
      expect(selected).toEqual([])
    }

    app.mockInput.pressKey("END")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(finalTitle)
    expect(app.captureCharFrame().replace(/\s+/g, " ")).toContain(finalReason)
    app.mockInput.pressEnter()
    expect(selected).toEqual([])
    app.mockInput.pressKey("\x1b[6~")
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain(finalTitle)
    expect(frame.replace(/\s+/g, " ")).toContain(finalReason)
    app.mockInput.pressEnter()
    expect(selected).toEqual([])
    if (enabledAt !== 8) {
      const y = frame.split("\n").findIndex((line) => line.includes(finalTitle))
      expect(y).toBeGreaterThan(0)
      await app.mockMouse.click(30, y)
      expect(selected).toEqual([])
    }

    for (let page = 0; page < 8; page++) {
      app.mockInput.pressKey("\x1b[5~")
      await app.renderOnce()
      if (app.captureCharFrame().includes(firstTitle)) break
    }
    expect(app.captureCharFrame()).toContain(firstTitle)
    app.mockInput.pressKey("\x1b[5~")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(firstTitle)
    app.mockInput.pressEnter()
    expect(selected).toEqual([])

    // Direction keys resume selection only once the enabled title is physically visible.
    app.mockInput.pressKey("HOME")
    await app.renderOnce()
    for (let line = 0; line < 80 && selected.length === 0; line++) {
      app.mockInput.pressArrow("down")
      await app.renderOnce()
      app.mockInput.pressEnter()
      if (selected.length > 0) expect(app.captureCharFrame()).toContain("Only enabled task")
    }
    expect(selected).toEqual(["enabled"])
    selected.length = 0
    app.mockInput.pressKey("END")
    await app.renderOnce()
    for (let line = 0; line < 80 && selected.length === 0; line++) {
      app.mockInput.pressArrow("up")
      await app.renderOnce()
      app.mockInput.pressEnter()
      if (selected.length > 0) expect(app.captureCharFrame()).toContain("Only enabled task")
    }
    expect(selected).toEqual(["enabled"])
  } finally {
    app.renderer.destroy()
  }
})
