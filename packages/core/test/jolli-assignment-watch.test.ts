import { describe, expect, test } from "bun:test"
import { assignmentSettledSession, createAssignmentRefresh } from "../src/jolli/assignment-watch"

describe("assignmentSettledSession", () => {
  for (const type of [
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.next.step.ended",
    "session.next.step.failed",
    "session.error",
  ]) {
    test(`accepts both event envelopes for ${type}`, () => {
      expect(assignmentSettledSession({ type, properties: { sessionID: "ses" } })).toBe("ses")
      expect(assignmentSettledSession({ type, data: { sessionID: "ses" } })).toBe("ses")
    })
  }
  test("accepts idle but ignores active/tool steps and malformed events", () => {
    expect(
      assignmentSettledSession({ type: "session.status", data: { sessionID: "ses", status: { type: "idle" } } }),
    ).toBe("ses")
    expect(
      assignmentSettledSession({ type: "session.status", properties: { sessionID: "ses", status: { type: "busy" } } }),
    ).toBeUndefined()
    expect(
      assignmentSettledSession({
        type: "session.next.step.ended",
        properties: { sessionID: "ses", finish: "tool-calls" },
      }),
    ).toBeUndefined()
    expect(assignmentSettledSession({ type: "message.part.updated", properties: { sessionID: "ses" } })).toBeUndefined()
    expect(
      assignmentSettledSession({ type: "session.status", properties: { sessionID: "ses", status: null } }),
    ).toBeUndefined()
    expect(assignmentSettledSession({ type: "session.error", properties: { sessionID: 1 } })).toBeUndefined()
    expect(assignmentSettledSession({ type: "session.error", properties: null })).toBeUndefined()
  })
})

describe("createAssignmentRefresh", () => {
  test("concurrent polls share one cached read, with one fresh read after settlement", async () => {
    const first = Promise.withResolvers<number>()
    const freshness: boolean[] = []
    const answers: number[] = []
    const reader = createAssignmentRefresh(
      async (fresh) => {
        freshness.push(fresh)
        return freshness.length === 1 ? first.promise : 2
      },
      (answer) => answers.push(answer),
    )
    const initial = reader.refresh()
    expect(reader.refresh()).toBe(initial)
    expect(reader.refresh(true)).toBe(initial)
    expect(reader.refresh(true)).toBe(initial)
    expect(freshness).toEqual([false])
    first.resolve(1)
    expect(await initial).toBe(2)
    expect(freshness).toEqual([false, true])
    expect(answers).toEqual([1, 2])
  })
  test("a poll after publication receives a new cached answer before the older promise settles", async () => {
    const published = Promise.withResolvers<void>()
    const freshness: boolean[] = []
    const reader = createAssignmentRefresh(
      async (fresh) => {
        freshness.push(fresh)
        return freshness.length
      },
      (answer) => {
        if (answer === 1) published.resolve()
      },
    )
    const initial = reader.refresh()
    await published.promise
    expect(reader.refresh()).toBe(initial)
    expect(await initial).toBe(2)
    expect(freshness).toEqual([false, false])
    expect(reader.loading()).toBe(false)
  })

  test("a settlement queued behind a failed read still gets its fresh read", async () => {
    const first = Promise.withResolvers<number>()
    const freshness: boolean[] = []
    const answers: number[] = []
    const reader = createAssignmentRefresh(
      async (fresh) => {
        freshness.push(fresh)
        return freshness.length === 1 ? first.promise : 2
      },
      (answer) => answers.push(answer),
    )
    const initial = reader.refresh()
    void reader.refresh(true)
    first.reject(new Error("offline"))
    expect(await initial).toBe(2)
    expect(freshness).toEqual([false, true])
    expect(answers).toEqual([2])
    expect(reader.loading()).toBe(false)
  })

  test("disposing a pending read suppresses publication and trailing requests", async () => {
    const first = Promise.withResolvers<number>()
    const answers: number[] = []
    const freshness: boolean[] = []
    const reader = createAssignmentRefresh(
      async (fresh) => {
        freshness.push(fresh)
        return first.promise
      },
      (answer) => answers.push(answer),
    )
    const pending = reader.refresh()
    void reader.refresh(true)
    reader.dispose()
    first.resolve(1)
    await pending
    expect(answers).toEqual([])
    expect(freshness).toEqual([false])
  })
})
