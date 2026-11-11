import { describe, expect, test } from "bun:test"
import type { Jolli } from "@opencode-ai/schema/jolli"
import {
  isParticipation,
  firstHandInAction,
  needsFirstHandIn,
  openOptionalTasks,
  participationSubmitted,
  participationWorkBlocked,
  taskActionsOf,
  taskStandingOf,
} from "../src/jolli/assignment-actions"

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

  test("keeps a hand-in labelled handed in after the teacher switches the task to participation", () => {
    const handedIn = {
      ...task,
      requiresExplicitSubmit: false,
      completionKind: "hand_in" as const,
      handedInAt: "2026-10-26T01:00:00Z",
    }
    expect(isParticipation(handedIn)).toBe(true)
    expect(participationSubmitted(handedIn)).toBe(false)
  })

  test("recognizes participation consistently when only its receipt declares the mode", () => {
    const done = { ...task, completionKind: "participation" as const, handedInAt: "2026-10-26T01:00:00Z" }
    expect(isParticipation(undefined)).toBe(false)
    expect(isParticipation(done)).toBe(true)
    expect(participationSubmitted(done)).toBe(true)
    expect(participationWorkBlocked(assignment, done)).toBe(true)
  })
})

describe("taskStandingOf", () => {
  const open = { ...task, local: null }
  test("says where a task stands", () => {
    expect(taskStandingOf(open).kind).toBe("not-started")
    expect(taskStandingOf(task).kind).toBe("in-progress")
    expect(taskStandingOf({ ...open, elsewhere: true }).kind).toBe("elsewhere")
    expect(taskStandingOf({ ...open, place: "web" }).kind).toBe("web")
    expect(taskStandingOf({ ...open, owed: false }).kind).toBe("not-owed")
    expect(taskStandingOf({ ...open, handedInAt: "2026-10-26T01:00:00Z" }).kind).toBe("handed-in")
    expect(taskStandingOf({ ...open, completionKind: "participation", handedInAt: "2026-10-26T01:00:00Z" }).kind).toBe(
      "submitted",
    )
  })
  test("marks an optional task only while it is owed", () => {
    expect(taskStandingOf(open).optional).toBe(false)
    expect(taskStandingOf({ ...open, optional: true })).toEqual({ kind: "not-started", optional: true })
    expect(taskStandingOf({ ...open, optional: true, owed: false })).toEqual({ kind: "not-owed", optional: false })
  })
})

describe("openOptionalTasks", () => {
  test("lists the optional tasks owed and not handed in", () => {
    const skipped = { ...task, partId: "31", optional: true }
    const handed = { ...task, partId: "32", optional: true, handedInAt: "2026-10-26T01:00:00Z" }
    const removed = { ...task, partId: "33", optional: true, owed: false }
    expect(openOptionalTasks({ tasks: [task, skipped, handed, removed] }).map((item) => item.partId)).toEqual(["31"])
  })
})

describe("needsFirstHandIn", () => {
  test("explains the first-receipt rule only for owed optional tasks with none handed in", () => {
    const optional = { ...task, optional: true }
    expect(needsFirstHandIn({ tasks: [optional] })).toBe(true)
    expect(needsFirstHandIn({ tasks: [optional, { ...task, owed: false }] })).toBe(true)
    expect(needsFirstHandIn({ tasks: [optional, task] })).toBe(false)
    expect(needsFirstHandIn({ tasks: [{ ...optional, handedInAt: "2026-10-26T01:00:00Z" }] })).toBe(false)
    expect(needsFirstHandIn({ tasks: [{ ...optional, owed: false }] })).toBe(false)
    expect(needsFirstHandIn({ tasks: [] })).toBe(false)
  })
})

describe("firstHandInAction", () => {
  test("offers only an available way to earn the first optional receipt", () => {
    const optional = { ...task, optional: true }
    const participation = { ...optional, requiresExplicitSubmit: false }
    expect(firstHandInAction({ ...assignment, tasks: [optional] })).toBe("hand-in")
    expect(firstHandInAction({ ...assignment, tasks: [participation] })).toBe("participate")
    expect(firstHandInAction({ ...assignment, tasks: [participation, optional] })).toBe("hand-in")
    expect(firstHandInAction({ ...assignment, tasks: [participation, { ...optional, workBlocked: true }] })).toBe(
      "participate",
    )
    expect(firstHandInAction({ ...assignment, tasks: [{ ...optional, workBlocked: true }] })).toBeUndefined()
    expect(firstHandInAction({ ...assignment, turnedIn: true, tasks: [optional] })).toBeUndefined()
    expect(firstHandInAction({ ...assignment, tasks: [optional, task] })).toBeUndefined()
    expect(
      firstHandInAction({ ...assignment, tasks: [{ ...participation, handedInAt: "2026-10-26T01:00:00Z" }] }),
    ).toBeUndefined()
  })
})
