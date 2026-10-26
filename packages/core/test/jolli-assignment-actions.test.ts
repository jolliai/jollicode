import { describe, expect, test } from "bun:test"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { participationSubmitted, participationWorkBlocked, taskActionsOf } from "../src/jolli/assignment-actions"

const task: Jolli.AssignmentTask = {
  partId: "30",
  title: "Task 1",
  name: "Practice",
  assistantId: "7",
  assistantBlurb: null,
  place: "jolli_code",
  handedInAt: null,
  handedInSessionID: null,
  owed: true,
  local: { sessionID: "practice", directory: "/project" },
  elsewhere: false,
}
const assignment: Jolli.Assignment = {
  id: "3",
  courseId: "42",
  courseCode: "CS",
  title: "Practice",
  description: "",
  dueAt: null,
  stopAtDue: false,
  authorName: null,
  tasksHandedIn: 0,
  tasksTotal: 1,
  turnedIn: false,
  readyToTurnIn: false,
  tasks: [task],
}

describe("taskActionsOf", () => {
  test("keeps completed participation continuable and restartable, without calling it a handed-in session", () => {
    const done = {
      ...task,
      requiresExplicitSubmit: false,
      completionKind: "participation" as const,
      handedInAt: "2026-10-26T01:00:00Z",
      workBlocked: false,
    }
    expect(taskActionsOf(assignment, done)).toEqual({
      canStart: false,
      canContinue: true,
      canRestart: true,
      canOpen: false,
      readOnly: false,
    })
    expect(participationSubmitted(done)).toBe(true)
    expect(participationWorkBlocked(assignment, done)).toBe(false)
  })
  test("opens completed work read-only after turn-in while allowing new owed tasks", () => {
    const turnedIn = { ...assignment, turnedIn: true }
    const done = { ...task, requiresExplicitSubmit: false, handedInAt: "2026-10-26T01:00:00Z", workBlocked: true }
    expect(participationWorkBlocked(turnedIn, done)).toBe(true)
    expect(taskActionsOf(turnedIn, done)).toMatchObject({
      canContinue: false,
      canRestart: false,
      canOpen: true,
      readOnly: true,
    })
    expect(taskActionsOf(turnedIn, { ...task, requiresExplicitSubmit: false, workBlocked: false })).toMatchObject({
      canContinue: true,
      canRestart: true,
    })
    expect(
      taskActionsOf(turnedIn, { ...task, local: null, requiresExplicitSubmit: false, workBlocked: false }).canStart,
    ).toBe(true)
  })
  test("honors the server's lifecycle refusal and the legacy hand-in contract", () => {
    expect(taskActionsOf(assignment, { ...task, requiresExplicitSubmit: false, workBlocked: true })).toMatchObject({
      canContinue: false,
      canRestart: false,
    })
    expect(taskActionsOf(assignment, task)).toMatchObject({ canContinue: true, canRestart: false })
    expect(taskActionsOf(assignment, { ...task, handedInAt: "2026-10-26T01:00:00Z" })).toMatchObject({
      canContinue: false,
      canOpen: true,
    })
    expect(taskActionsOf(assignment, { ...task, place: "web" }).canContinue).toBe(false)
    expect(taskActionsOf(assignment, { ...task, owed: false }).canContinue).toBe(false)
    expect(participationSubmitted(undefined)).toBe(false)
    expect(participationSubmitted(task)).toBe(false)
    expect(
      participationWorkBlocked(assignment, { ...task, workBlocked: true, handedInAt: "2026-10-26T01:00:00Z" }),
    ).toBe(false)
    expect(
      participationWorkBlocked(assignment, {
        ...task,
        completionKind: "participation",
        requiresExplicitSubmit: true,
        handedInAt: "2026-10-26T01:00:00Z",
      }),
    ).toBe(true)
  })
})
