import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssignmentRead } from "@opencode-ai/core/jolli/assignment"
import { createAssignmentWatches } from "@/jolli/assignment-watch"

const assignment = (submitted = false, blocked = false): AssignmentRead => ({
  status: "ok",
  assignment: {
    id: "2",
    courseId: "1",
    courseCode: "CS",
    title: "Practice",
    description: "",
    authorName: null,
    dueAt: null,
    stopAtDue: false,
    tasksHandedIn: Number(submitted),
    tasksTotal: 1,
    turnedIn: blocked,
    readyToTurnIn: submitted && !blocked,
    tasks: [
      {
        partId: "3",
        title: "Task 1",
        name: "Practice",
        assistantId: "7",
        assistantBlurb: null,
        place: "jolli_code",
        requiresExplicitSubmit: false,
        completionKind: "participation",
        handedInAt: submitted ? "2026-10-26T00:00:00Z" : null,
        handedInSessionID: null,
        workBlocked: blocked,
        owed: true,
        local: { sessionID: "ses", directory: "/project" },
        elsewhere: false,
      },
    ],
  },
})

function fixture() {
  const watchers = createAssignmentWatches()
  const listeners = new Set<(event: { type: string; properties: unknown }) => void>()
  const state = { loads: 0, settles: 0, answer: assignment(), defer: undefined as undefined | Promise<AssignmentRead> }
  const [generation, setGeneration] = createStore({ value: 0 })
  const client = {}
  const acquire = (sessionID = "ses", target = client) =>
    createRoot((dispose) => ({
      dispose,
      read: watchers.acquire({
        client: target,
        courseId: "1",
        assignmentId: "2",
        sessionID,
        generation: () => generation.value,
        load: async () => {
          state.loads++
          return state.defer ?? state.answer
        },
        listen: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        settled: () => {
          state.settles++
          setGeneration("value", (value) => value + 1)
        },
      }),
    }))
  const emit = (type: string, properties: unknown = { sessionID: "ses" }) => {
    for (const listener of listeners) listener({ type, properties })
  }
  return { state, acquire, emit, listeners }
}

/** Wait for a reactive outcome, without sleeps or a guessed number of promise turns. */
function observed(predicate: () => boolean) {
  return new Promise<void>((resolve) =>
    createRoot((dispose) =>
      createEffect(() => {
        if (!predicate()) return
        dispose()
        resolve()
      }),
    ),
  )
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => jest.useRealTimers())

describe("assignment watches", () => {
  test("both headers share their read, subscription and polling lifetime", async () => {
    const f = fixture()
    const first = f.acquire()
    const second = f.acquire()
    await observed(() => first.read()?.status === "ok" && second.read()?.status === "ok")
    expect(f.state.loads).toBe(1)
    expect(f.listeners.size).toBe(1)
    first.dispose()
    expect(f.listeners.size).toBe(1)
    second.dispose()
    expect(f.listeners.size).toBe(0)
    jest.advanceTimersByTime(60_000)
    window.dispatchEvent(new Event("focus"))
    expect(f.state.loads).toBe(1)
  })

  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.next.step.ended",
    "session.next.step.failed",
    "session.error",
  ]) {
    test(`refreshes persisted participation after ${type}`, async () => {
      const f = fixture()
      const view = f.acquire()
      await observed(() => view.read()?.status === "ok")
      f.state.answer = assignment(true)
      f.emit(type)
      await observed(() => {
        const read = view.read()
        return read?.status === "ok" && read.assignment.tasksHandedIn === 1
      })
      expect(f.state.settles).toBe(1)
      expect(f.state.loads).toBe(2)
      view.dispose()
    })
  }

  test("ignores streamed tool parts and other sessions, then refreshes on legacy idle", async () => {
    const f = fixture()
    const view = f.acquire()
    await observed(() => view.read()?.status === "ok")
    for (let index = 0; index < 20; index++)
      f.emit("message.part.updated", {
        part: { sessionID: "ses", id: `tool-${index}`, type: "tool", state: { status: "running" } },
      })
    f.emit("session.execution.succeeded", { sessionID: "other" })
    f.emit("session.next.step.ended", { sessionID: "ses", finish: "tool-calls" })
    f.emit("session.status", { sessionID: "ses", status: { type: "busy" } })
    expect(f.state.loads).toBe(1)
    expect(f.state.settles).toBe(0)
    f.state.answer = assignment(true)
    f.emit("session.status", { sessionID: "ses", status: { type: "idle" } })
    await observed(() => {
      const read = view.read()
      return read?.status === "ok" && read.assignment.tasksHandedIn === 1
    })
    expect(f.state.loads).toBe(2)
    view.dispose()
  })

  for (const trigger of ["clock", "focus", "visibility"] as const) {
    test(`a mounted read-only view sees teacher reopen through ${trigger}`, async () => {
      const f = fixture()
      f.state.answer = assignment(true, true)
      const first = f.acquire()
      const second = f.acquire()
      await observed(() => first.read()?.status === "ok")
      f.state.answer = assignment()
      if (trigger === "clock") jest.advanceTimersByTime(30_000)
      if (trigger === "focus") window.dispatchEvent(new Event("focus"))
      if (trigger === "visibility") document.dispatchEvent(new Event("visibilitychange"))
      await observed(() => {
        const read = first.read()
        return read?.status === "ok" && !read.assignment.tasks[0].workBlocked
      })
      expect(second.read()).toEqual(f.state.answer)
      expect(f.state.loads).toBe(2)
      expect(f.state.settles).toBe(0)
      first.dispose()
      second.dispose()
    })
  }

  test("settlement during an old read schedules one new read instead of losing completion", async () => {
    const f = fixture()
    let resolve!: (answer: AssignmentRead) => void
    f.state.defer = new Promise((done) => {
      resolve = done
    })
    const first = f.acquire()
    const second = f.acquire()
    f.state.answer = assignment(true)
    f.emit("session.execution.succeeded")
    f.state.defer = undefined
    resolve(assignment())
    await observed(() => {
      const read = first.read()
      return read?.status === "ok" && read.assignment.tasksHandedIn === 1
    })
    expect(f.state.loads).toBe(2)
    expect(second.read()).toEqual(f.state.answer)
    first.dispose()
    second.dispose()
  })

  test("client identities do not share answers", async () => {
    const f = fixture()
    const first = f.acquire()
    const second = f.acquire("ses", {})
    await observed(() => first.read()?.status === "ok" && second.read()?.status === "ok")
    expect(f.state.loads).toBe(2)
    expect(f.listeners.size).toBe(2)
    first.dispose()
    second.dispose()
  })
})
