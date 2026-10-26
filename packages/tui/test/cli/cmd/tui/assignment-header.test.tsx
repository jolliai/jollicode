/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { useEvent } from "../../../../src/context/event"
import { useTaskHeader } from "../../../../src/context/assignments"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait } from "./sync-fixture"

const sessionID = "ses_assignment_header"
const session = {
  id: sessionID,
  projectID: "proj_test",
  title: "Practice",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory,
  metadata: {
    jolli: { courseId: "1", assistantId: "2" },
    jolliTask: { sessionID, assignmentId: "3", partId: "4" },
  },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function answer(blocked: boolean) {
  return {
    status: "ok",
    assignment: {
      id: "3",
      courseId: "1",
      courseCode: "CS",
      title: "Practice",
      description: "",
      dueAt: null,
      stopAtDue: false,
      authorName: null,
      tasksHandedIn: 1,
      tasksTotal: 1,
      turnedIn: blocked,
      readyToTurnIn: !blocked,
      tasks: [
        {
          partId: "4",
          title: "Task 1",
          name: "Practice",
          assistantId: "2",
          assistantBlurb: null,
          place: "jolli_code",
          requiresExplicitSubmit: false,
          completionKind: "participation",
          handedInAt: "2026-10-26T01:00:00Z",
          handedInSessionID: null,
          workBlocked: blocked,
          owed: true,
          local: { sessionID, directory },
          elsewhere: false,
        },
      ],
    },
  }
}

test("refreshes task permission on settlement and idle polling without refreshing per tool part", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const intervals = spyOn(globalThis, "setInterval")
  const clear = spyOn(globalThis, "clearInterval")
  let header!: ReturnType<typeof useTaskHeader>
  let blocked = true
  let calls = 0
  let active = 0
  let maxActive = 0
  let release: (() => void) | undefined
  let hold = false
  let delivered!: () => void
  const settlement = new Promise<void>((resolve) => {
    delivered = resolve
  })
  const { app, emit, sync } = await mount(
    (url) => {
      if (url.pathname === "/session") return json([session])
      if (url.pathname !== "/jolli/assignment/1/3") return undefined
      return (async () => {
        calls++
        active++
        maxActive = Math.max(maxActive, active)
        const snapshot = answer(blocked)
        if (hold) {
          hold = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        active--
        return json(snapshot)
      })()
    },
    tmp.path,
    () => {
      header = useTaskHeader(() => sessionID)
      onCleanup(
        useEvent().subscribe((evt) => {
          if (evt.id === "evt_idle_after_failure") delivered()
        }),
      )
    },
  )

  const pollIndex = intervals.mock.calls.findIndex(([, delay]) => delay === 30_000)
  const pollCallback = intervals.mock.calls[pollIndex]?.[0]
  const pollTimer = intervals.mock.results[pollIndex]?.value
  const poll = () => {
    if (typeof pollCallback !== "function") throw new Error("assignment polling interval was not registered")
    pollCallback(undefined)
  }
  try {
    await wait(() => header()?.workBlocked === true)
    expect(calls).toBe(1)
    for (let index = 0; index < 20; index++) {
      emit(
        global({
          id: `evt_tool_${index}`,
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 2,
            part: {
              id: `prt_tool_${index}`,
              sessionID,
              messageID: "msg_tools",
              type: "tool",
              callID: `call_${index}`,
              tool: "read",
              state: {
                status: "completed",
                input: {},
                output: "",
                title: "Read",
                metadata: {},
                time: { start: 1, end: 2 },
              },
            },
          },
        }),
      )
    }
    await wait(() => sync.data.part.msg_tools?.length === 20)
    emit(
      global({
        id: "evt_tool_step",
        type: "session.next.step.ended",
        properties: {
          sessionID,
          timestamp: 1,
          assistantMessageID: "msg_tools",
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    )
    emit(
      global({
        id: "evt_busy_after_tools",
        type: "session.status",
        properties: { sessionID, status: { type: "busy" } },
      }),
    )
    await wait(() => sync.data.session_status[sessionID]?.type === "busy")
    expect(calls).toBe(1)

    // Settlement during an older GET must cause a serialized trailing GET, not reuse its stale answer.
    hold = true
    emit(global({ id: "evt_idle", type: "session.status", properties: { sessionID, status: { type: "idle" } } }))
    await wait(() => !!release)
    blocked = false
    emit(
      global({
        id: "evt_failed",
        type: "session.next.step.failed",
        properties: {
          sessionID,
          timestamp: 2,
          assistantMessageID: "msg_failed",
          error: { type: "unknown", message: "Failed" },
        },
      }),
    )
    // Wait for delivery through the SDK's event batching before releasing the stale GET.
    emit(
      global({
        id: "evt_idle_after_failure",
        type: "session.status",
        properties: { sessionID, status: { type: "idle" } },
      }),
    )
    await settlement
    release!()
    await wait(() => header()?.workBlocked === false)
    expect(calls).toBe(3)
    expect(maxActive).toBe(1)

    blocked = true
    poll()
    await wait(() => header()?.workBlocked === true)
    blocked = false
    poll()
    await wait(() => header()?.workBlocked === false)
    expect(calls).toBe(5)
  } finally {
    app.renderer.destroy()
    expect(pollTimer).toBeDefined()
    expect(clear.mock.calls.some(([timer]) => timer === pollTimer)).toBe(true)
    intervals.mockRestore()
    clear.mockRestore()
  }
})
