/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { providerIdFor } from "@opencode-ai/core/jolli/gateway-config"
import { refreshAssignment } from "../../src/context/assignments"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { useEvent } from "../../src/context/event"
import { ExitProvider } from "../../src/context/exit"
import { JolliProvider, useJolli } from "../../src/context/jolli"
import { KVProvider } from "../../src/context/kv"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider, useSDK } from "../../src/context/sdk"
import { SyncProvider } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { DialogAssignmentTasks } from "../../src/component/dialog-assignment"
import { TuiConfigProvider } from "../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { wait } from "../cli/cmd/tui/sync-fixture"

const sessionID = "ses_assignment_dialog"
const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "Review",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory,
  metadata: {
    jolli: { courseId: "1", assistantId: "2" },
    jolliTask: { sessionID, assignmentId: "3", partId: "4" },
  },
}

function answer(blocked: boolean, webOnly = false) {
  const normal = {
    status: "ok",
    assignment: {
      id: "3",
      courseId: "1",
      courseCode: "CS",
      title: "Ordered practice",
      description: "",
      dueAt: null,
      stopAtDue: false,
      authorName: null,
      tasksHandedIn: blocked ? 0 : 1,
      tasksTotal: 2,
      turnedIn: false,
      readyToTurnIn: false,
      tasks: [
        {
          partId: "4",
          title: "Task 1",
          name: "Review materials",
          assistantId: "2",
          assistantBlurb: null,
          place: "jolli_code",
          handedInAt: blocked ? null : "2026-11-21T10:00:00Z",
          handedInSessionID: blocked ? null : sessionID,
          owed: true,
          local: { sessionID, directory },
          elsewhere: false,
        },
        {
          partId: "5",
          title: "Task 2",
          name: "Statements Coach",
          assistantId: "2",
          assistantBlurb: null,
          place: "jolli_code",
          handedInAt: null,
          handedInSessionID: null,
          owed: true,
          local: null,
          elsewhere: false,
          ...(blocked ? { orderWait: { taskId: 4, taskName: "Review materials" } } : {}),
        },
      ],
    },
  }
  if (!webOnly) return normal
  return {
    ...normal,
    assignment: {
      ...normal.assignment,
      tasksHandedIn: 0,
      tasksTotal: 1,
      tasks: [
        {
          partId: "6",
          title: "Task 3",
          name: "A valid web-only task with a long name that fills the whole default assignment dialog title line",
          assistantId: null,
          assistantBlurb: null,
          place: "web",
          handedInAt: null,
          handedInSessionID: null,
          owed: true,
          local: null,
          elsewhere: false,
        },
      ],
    },
  }
}

function toolCompleted(id: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.updated",
      properties: {
        sessionID,
        time: 2,
        part: {
          id: `prt_${id}`,
          sessionID,
          messageID: "msg_hand_in",
          type: "tool",
          callID: `call_${id}`,
          tool: "jolli_submit_task",
          state: {
            status: "completed",
            input: {},
            output: "Submitted",
            title: "Submit task",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    },
  }
}

test("an open modal follows hand-in, refusal refresh, and settlement without stale or overlapping reads", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const state = {
    blocked: true,
    webOnly: false,
    hold: false,
    release: undefined as (() => void) | undefined,
    calls: 0,
    active: 0,
    maxActive: 0,
  }
  const delivered = new Set<string>()
  const fetch = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: [providerIdFor("anthropic")] })
    if (url.pathname === "/jolli/course") return json({ status: "ok", courses: [], assistants: [], modelTiers: {} })
    if (url.pathname !== "/jolli/assignment/1/3") return undefined
    return (async () => {
      state.calls++
      state.active++
      state.maxActive = Math.max(state.maxActive, state.active)
      const snapshot = answer(state.blocked, state.webOnly)
      if (state.hold) {
        state.hold = false
        await new Promise<void>((resolve) => {
          state.release = resolve
        })
      }
      state.active--
      return json(snapshot)
    })()
  })
  let sdk!: ReturnType<typeof useSDK>
  let jolli!: ReturnType<typeof useJolli>
  let dialog!: ReturnType<typeof useDialog>
  let mounted!: () => void
  const ready = new Promise<void>((resolve) => {
    mounted = resolve
  })
  function Probe() {
    sdk = useSDK()
    jolli = useJolli()
    dialog = useDialog()
    onCleanup(useEvent().subscribe((evt) => delivered.add(evt.id)))
    onMount(() => {
      dialog.replace(() => <DialogAssignmentTasks courseId="1" assignmentId="3" />)
      mounted()
    })
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
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
                      <SDKProvider url="http://test" directory={directory} fetch={fetch.fetch} events={events.source}>
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
  const app = await testRender(() => <Harness />, { width: 100, height: 32, kittyKeyboard: true })
  async function showsWaiting(waiting: boolean) {
    await app.waitFor(() => app.captureCharFrame().includes("Submit Review materials first") === waiting)
  }
  try {
    await ready
    await showsWaiting(true)
    expect(state.calls).toBe(1)
    state.hold = true
    const old = refreshAssignment(sdk.client, "1", "3")
    await wait(() => state.release !== undefined)
    state.blocked = false
    events.emit(toolCompleted("evt_hand_in"))
    await wait(() => delivered.has("evt_hand_in"))
    state.release!()
    await old
    await showsWaiting(false)
    expect(state.calls).toBe(3)
    expect(state.maxActive).toBe(1)

    // The prompt's refusal refresh uses this same service; its response must reach the still-open dialog.
    state.blocked = true
    await refreshAssignment(sdk.client, "1", "3")
    await showsWaiting(true)
    state.blocked = false
    events.emit({
      directory,
      project: "proj_test",
      payload: {
        id: "evt_settled",
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      },
    })
    await showsWaiting(false)
    expect(state.calls).toBe(5)
    expect(state.maxActive).toBe(1)

    // A long web-only task has no orderWait, but its only explanation must remain readable in this 60-column modal.
    state.webOnly = true
    await refreshAssignment(sdk.client, "1", "3")
    await app.waitFor(() => app.captureCharFrame().includes("Do this task on the web"))
    expect(app.captureCharFrame()).toContain("A valid web-only task with a long name")
    expect(app.captureCharFrame()).toContain("Do this task on the web")
    app.mockInput.pressEnter()
    expect(jolli.draft.task).toBeUndefined()
    expect(dialog.stack).toHaveLength(1)
    const webReasonRow = app
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Do this task on the web"))
    expect(webReasonRow).toBeGreaterThan(0)
    await app.mockMouse.click(30, webReasonRow)
    expect(jolli.draft.task).toBeUndefined()
    expect(dialog.stack).toHaveLength(1)
    state.webOnly = false
    await refreshAssignment(sdk.client, "1", "3")
    await app.waitFor(() => app.captureCharFrame().includes("Statements Coach"))

    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await wait(() => jolli.draft.task?.partId === "5")
    expect(dialog.stack).toHaveLength(0)
    events.emit(toolCompleted("evt_after_close"))
    await wait(() => delivered.has("evt_after_close"))
    expect(state.calls).toBe(7)
  } finally {
    state.release?.()
    app.renderer.destroy()
  }
})
