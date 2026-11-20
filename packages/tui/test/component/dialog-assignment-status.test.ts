import { expect, test } from "bun:test"
import type { Jolli } from "@opencode-ai/schema/jolli"
import { taskCount, taskStatus } from "../../src/component/dialog-assignment"

function task(overrides: Partial<Jolli.AssignmentTask> = {}): Jolli.AssignmentTask {
  return {
    partId: "41",
    title: "Task 1",
    name: "CS 310 Lab Assistant",
    assistantId: null,
    assistantBlurb: null,
    place: "jolli_code",
    handedInAt: null,
    handedInSessionID: null,
    owed: true,
    local: null,
    elsewhere: false,
    ...overrides,
  }
}

const when = (instant: string) => instant.slice(0, 10)

test("says where a task stands", () => {
  expect(taskStatus(task(), when)).toBe("Not started")
  expect(taskStatus(task({ place: "web" }), when)).toBe("Do this task on the web")
  expect(taskStatus(task({ owed: false }), when)).toBe("No longer needed")
  expect(taskStatus(task({ handedInAt: "2026-10-21T10:00:00Z" }), when)).toBe("Handed in 2026-10-21")
})

test("puts the order blocker before a web-only task's generic standing", () => {
  const orderWait = { taskId: 40, taskName: "Review materials" }
  expect(taskStatus(task({ place: "web", orderWait }), when)).toBe("Submit Review materials first")
  expect(taskStatus(task({ place: "web", orderWait }), when, "es_MX.UTF-8")).toBe("Envía primero Review materials")
})

test("says an optional task is optional before where it stands", () => {
  expect(taskStatus(task({ optional: true }), when)).toBe("Optional · Not started")
  expect(taskStatus(task({ optional: true, place: "web" }), when)).toBe("Optional · Do this task on the web")
  expect(taskStatus(task({ optional: true, handedInAt: "2026-10-21T10:00:00Z" }), when)).toBe(
    "Optional · Handed in 2026-10-21",
  )
  expect(taskStatus(task({ optional: true, owed: false }), when)).toBe("No longer needed")
})

test("keeps optional status in complete localized waiting phrases", () => {
  const orderWait = { taskId: 40, taskName: "Review materials" }
  expect(taskStatus(task({ optional: true, orderWait }), when, "en_US.UTF-8")).toBe(
    "Optional · Submit Review materials first",
  )
  expect(taskStatus(task({ optional: true, orderWait, place: "web" }), when, "es_MX.UTF-8")).toBe(
    "Opcional · Envía primero Review materials",
  )
})

test("counts optional tasks apart from the ones to hand in", () => {
  const summary = {
    id: "40",
    courseId: "7",
    courseCode: "CS 310",
    title: "Lab 4",
    dueAt: null,
    stopAtDue: false,
    tasksHandedIn: 1,
    tasksTotal: 2,
  }
  expect(taskCount(summary)).toBe("1/2 tasks handed in")
  expect(taskCount({ ...summary, optionalHandedIn: 0, optionalTotal: 1 })).toBe("1/2 tasks handed in · 0/1 optional")
  expect(taskCount({ ...summary, tasksHandedIn: 0, tasksTotal: 0, optionalHandedIn: 1, optionalTotal: 2 })).toBe(
    "1/2 optional tasks handed in",
  )
})
