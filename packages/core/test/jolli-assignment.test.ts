import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  fetchStudentAssignment,
  fetchStudentAssignments,
  handIn,
  JolliApiError,
  previewHandIn,
  startTaskSession,
  turnInAssignment,
  type GatewayRequest,
  type HandInPreview,
  type StudentAssignment,
  type StudentAssignmentAgentPart,
  type StudentAssignmentList,
  type StudentAssignmentOtherPart,
  type StudentAssignmentPart,
} from "../src/jolli/api"
import {
  handedInBy,
  handInLines,
  isAgentPart,
  isNeverAutoApproved,
  projectAssignment,
  SUBMIT_TASK_PERMISSION,
  inTaskSession,
  taskApprovalKey,
  taskDraftOf,
  taskBindingOf,
  taskSessionIDs,
  todoAssignments,
  TURN_IN_PERMISSION,
  turnInBlocker,
  turnInLines,
} from "../src/jolli/assignment"
import { JolliAssignmentCache } from "../src/jolli/assignment-cache"
import { assignmentRefusalOf } from "../src/jolli/refusal"

const REQUEST: GatewayRequest = { origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }
const NOW = Date.parse("2026-10-22T12:00:00Z")
const CS310 = { id: "7", code: "CS 310" }

afterEach(() => JolliAssignmentCache.reset())

function stub(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const seen: HttpClientRequest.HttpClientRequest[] = []
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      seen.push(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, handler(request)))
    }),
  )
  return { seen, layer }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined) => {
  const body = request?.body
  return JSON.parse(new TextDecoder().decode(body?._tag === "Uint8Array" ? body.body : undefined))
}

const progress = { state: "in_progress", partsSubmitted: 0, partsTotal: 2, turnedInAt: null }

function listItem(overrides: Partial<StudentAssignmentList["todo"][number]> = {}) {
  return {
    id: 40,
    title: "Lab 4: Linked lists",
    description: "",
    status: "published",
    opensAt: null,
    dueAt: "2026-10-24T23:59:00Z",
    stopAtDue: true,
    progress,
    tasks: [
      { partId: 41, assistantId: 12, workedIn: "web_chat", submitted: true },
      { partId: 42, assistantId: 13, workedIn: "jolli_code", submitted: false },
    ],
    ...overrides,
  }
}

function part(overrides: Partial<StudentAssignmentAgentPart> = {}): StudentAssignmentAgentPart {
  return {
    id: 42,
    assistantId: 13,
    assistantName: "CS 310 Lab Assistant",
    assistantBlurb: "Helps with the lab",
    assistantStatus: "live",
    turnIn: { transcript: true, summary: true, reflection: true },
    reflectionPrompt: "What was the hardest bug?",
    workedIn: "jolli_code",
    attempts: [],
    submission: null,
    owed: true,
    ...overrides,
  }
}

/** A File upload task: a kind with no agent, worked on the web alone. */
function filePart(overrides: Partial<StudentAssignmentOtherPart> = {}): StudentAssignmentOtherPart {
  return { id: 44, kind: "files", name: "Lab report", submission: null, owed: true, ...overrides }
}

function assignment(parts: StudentAssignmentPart[], overrides: Partial<StudentAssignment> = {}): StudentAssignment {
  return {
    id: 40,
    courseId: 7,
    title: "Lab 4: Linked lists",
    description: "Implement a linked list",
    opensAt: null,
    dueAt: "2026-10-24T23:59:00Z",
    stopAtDue: true,
    status: "published",
    progress,
    authorName: "Prof. Okafor",
    parts,
    ...overrides,
  }
}

const preview: HandInPreview = {
  assignmentTitle: "Lab 4: Linked lists",
  taskTitle: "Task 2",
  staffLabel: "Prof. Okafor and CS 310 staff",
  messageCount: 38,
  throughSeq: 77,
  includes: { transcript: true, summary: true, reflection: true },
  summary: { kind: "ready", throughSeq: 77, summary: "Finished with all seven tests passing." },
  reflectionPrompt: "What was the hardest bug?",
  reflection: "the empty list. i kept fixing the loop",
  project: {
    remoteUrl: "https://github.com/cs310-fall26/lab4-jordanlee.git",
    branch: "main",
    commits: [
      { sha: "a".repeat(40), shortSha: "aaaaaaa", subject: "one", committedAt: "2026-10-21T10:00:00Z", pushed: true },
      { sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "two", committedAt: "2026-10-21T11:00:00Z", pushed: true },
      {
        sha: "c".repeat(40),
        shortSha: "ccccccc",
        subject: "three",
        committedAt: "2026-10-21T12:00:00Z",
        pushed: false,
      },
    ],
    pullRequests: [{ url: "https://github.com/cs310-fall26/lab4-jordanlee/pull/3", number: 3 }],
  },
}

describe("taskBindingOf", () => {
  test("reads the task a session was started for", () => {
    const session = {
      id: "ses_a",
      metadata: { jolliTask: { sessionID: "ses_a", assignmentId: "40", partId: "42", startHead: "9f0c1aa" } },
    }
    expect(taskBindingOf(session)).toEqual({ assignmentId: "40", partId: "42", startHead: "9f0c1aa" })
  })

  /** ⚠ A FORK OR A CHILD CARRIES THE RECORD UNDER ANOTHER ID, AND IS A PLAIN SESSION. */
  test("a copy under another session's id, or a malformed record, is no task", () => {
    expect(
      taskBindingOf({
        id: "ses_fork",
        metadata: { jolliTask: { sessionID: "ses_a", assignmentId: "40", partId: "42" } },
      }),
    ).toBeUndefined()
    expect(
      taskBindingOf({ id: "ses_a", metadata: { jolliTask: { sessionID: "ses_a", assignmentId: 40 } } }),
    ).toBeUndefined()
    expect(taskBindingOf({ id: "ses_a", metadata: {} })).toBeUndefined()
    expect(taskBindingOf(undefined)).toBeUndefined()
  })
})

describe("inTaskSession", () => {
  const record = { sessionID: "ses_a", assignmentId: "40", partId: "42" }

  const root = { id: "ses_a", metadata: { jolliTask: record } }

  test("recognizes a task root and nested children without inherited metadata", async () => {
    const child = { id: "ses_child", parentID: root.id }
    const nested = { id: "ses_nested", parentID: child.id, metadata: { jolliTask: { partId: 42 } } }
    const sessions = new Map([root, child, nested].map((session) => [session.id, session]))
    const read = (id: string) => Effect.succeed(sessions.get(id))
    expect(await Effect.runPromise(inTaskSession(root, read))).toBe(true)
    expect(await Effect.runPromise(inTaskSession(child, read))).toBe(true)
    expect(await Effect.runPromise(inTaskSession(nested, read))).toBe(true)
  })

  test("rejects historical descendants of a fork despite copied task records", async () => {
    const fork = { ...root, id: "ses_fork" }
    const child = { ...root, id: "ses_child", parentID: fork.id }
    const nested = { ...root, id: "ses_nested", parentID: child.id }
    const sessions = new Map([fork, child, nested].map((session) => [session.id, session]))
    const read = (id: string) => Effect.succeed(sessions.get(id))
    for (const session of sessions.values()) {
      expect(await Effect.runPromise(inTaskSession(session, read))).toBe(false)
    }
  })

  test("ignores task records supplied on children of an ordinary root", async () => {
    const read = () => Effect.succeed({ id: "ses_plain" })
    for (const sessionID of [root.id, "ses_child", "ses_plain"]) {
      expect(
        await Effect.runPromise(
          inTaskSession(
            {
              id: "ses_child",
              parentID: "ses_plain",
              metadata: { jolliTask: { ...record, sessionID } },
            },
            read,
          ),
        ),
      ).toBe(false)
    }
  })

  test("fails closed for missing sessions, broken ancestry and cycles", async () => {
    const read = () => Effect.succeed(undefined)
    expect(await Effect.runPromise(inTaskSession(undefined, read))).toBe(false)
    expect(await Effect.runPromise(inTaskSession({ ...root, parentID: "ses_missing" }, read))).toBe(false)
    const child = { ...root, id: "ses_child", parentID: root.id }
    const cyclic = { ...root, parentID: child.id }
    expect(await Effect.runPromise(inTaskSession(child, (id) => Effect.succeed(id === root.id ? cyclic : child)))).toBe(
      false,
    )
  })

  test("does not accept an invalid binding on the root", async () => {
    expect(
      await Effect.runPromise(
        inTaskSession(
          {
            ...root,
            metadata: { jolliTask: { ...record, partId: 42 } },
          },
          () => Effect.succeed(undefined),
        ),
      ),
    ).toBe(false)
  })
})

describe("todoAssignments", () => {
  test("lists open assignments with a Jolli Code task, due soonest first, counting every kind's tasks", () => {
    const later = listItem({ id: 50, title: "Lab 5", dueAt: "2026-10-30T23:59:00Z" })
    // `tasks` holds the two agent tasks; the progress counts a File upload task beside them.
    const sooner = listItem({ progress: { ...progress, partsSubmitted: 1, partsTotal: 3 } })
    const undated = listItem({ id: 60, title: "Project", dueAt: null, stopAtDue: false })
    const list = { todo: [later, undated, sooner], upcoming: [], completed: [] }
    expect(todoAssignments([{ course: CS310, list }], NOW).map((item) => item.id)).toEqual(["40", "50", "60"])
    expect(todoAssignments([{ course: CS310, list }], NOW)[0]).toEqual({
      id: "40",
      courseId: "7",
      courseCode: "CS 310",
      title: "Lab 4: Linked lists",
      dueAt: "2026-10-24T23:59:00Z",
      stopAtDue: true,
      tasksHandedIn: 1,
      tasksTotal: 3,
    })
  })

  test("leaves out web-only, closed, and past-due assignments that stop at their due date", () => {
    const webOnly = listItem({
      id: 1,
      tasks: [{ partId: 41, assistantId: 12, workedIn: "web_chat", submitted: false }],
    })
    const older = listItem({ id: 2, tasks: undefined })
    const closed = listItem({ id: 3, status: "closed" })
    const stopped = listItem({ id: 4, dueAt: "2026-10-21T23:59:00Z" })
    const lateOk = listItem({ id: 5, dueAt: "2026-10-21T23:59:00Z", stopAtDue: false })
    const list = { todo: [webOnly, older, closed, stopped, lateOk], upcoming: [], completed: [] }
    expect(todoAssignments([{ course: CS310, list }], NOW).map((item) => item.id)).toEqual(["5"])
  })
})

describe("projectAssignment", () => {
  test("participation completion keeps work writable and does not turn its attempt into a handed-in chat", () => {
    const practice = part({
      turnIn: { transcript: false, summary: false, reflection: false },
      submission: { attemptId: 2, submittedAt: "2026-10-22T10:00:00Z", completionKind: "participation" },
      attempts: [
        {
          id: 2,
          conversationId: "ses_completed",
          countedAt: "2026-10-20T10:00:00Z",
          lastHumanMessageAt: "2026-10-22T11:00:00Z",
        },
        { id: 3, conversationId: "ses_restart", countedAt: null },
      ],
    })
    const locals = new Map([
      ["ses_completed", { directory: "/lab", updated: 9 }],
      ["ses_restart", { directory: "/restart", updated: 1 }],
    ])
    const read = assignment([practice], { progress: { ...progress, partsSubmitted: 1, partsTotal: 1 } })
    const projected = projectAssignment(CS310, read, locals, NOW)
    expect(projected.tasks[0]).toMatchObject({
      requiresExplicitSubmit: false,
      completionKind: "participation",
      workBlocked: false,
      handedInSessionID: null,
      local: { sessionID: "ses_restart" },
    })
    expect(projected.readyToTurnIn).toBe(true)
    expect(taskDraftOf(projected, projected.tasks[0])).toBeDefined()
    expect(handedInBy(projected, { assignmentId: "40", partId: "42" }, "ses_completed")).toBe(false)
    const turned = projectAssignment(
      CS310,
      { ...read, progress: { ...read.progress, turnedInAt: "2026-10-22T11:30:00Z" } },
      locals,
      NOW,
    )
    expect(turned.tasks[0]?.workBlocked).toBe(true)
    expect(taskDraftOf(turned, turned.tasks[0])).toBeUndefined()
    const added = projectAssignment(
      CS310,
      {
        ...read,
        parts: [{ ...practice, submission: null }],
        progress: { ...read.progress, turnedInAt: "2026-10-22T11:30:00Z" },
      },
      locals,
      NOW,
    )
    expect(added.tasks[0]?.workBlocked).toBe(false)
    expect(taskDraftOf(added, added.tasks[0])).toBeDefined()
  })

  test("a participation receipt never becomes a handed-in session after the task switches to manual mode", () => {
    const projected = projectAssignment(
      CS310,
      assignment([
        part({
          submission: { attemptId: 2, submittedAt: "2026-10-22T10:00:00Z", completionKind: "participation" },
          attempts: [{ id: 2, conversationId: "ses_a", countedAt: "2026-10-20T10:00:00Z" }],
        }),
      ]),
      new Map(),
      NOW,
    )
    expect(projected.tasks[0]).toMatchObject({
      completionKind: "participation",
      requiresExplicitSubmit: true,
      workBlocked: true,
      handedInSessionID: null,
    })
  })

  test("names tasks by place, and finds the newest of a task's sessions on this machine", () => {
    const read = assignment([
      part({
        id: 41,
        assistantId: 12,
        workedIn: "web_chat",
        attempts: [{ id: 1, conversationId: "web_1", countedAt: null }],
      }),
      part({
        attempts: [
          { id: 2, conversationId: "ses_old", countedAt: "2026-10-20T10:00:00Z" },
          { id: 3, conversationId: "ses_new", countedAt: null },
          { id: 4, conversationId: "ses_other_machine", countedAt: null },
        ],
      }),
    ])
    const locals = new Map([
      ["ses_old", { directory: "/home/jordan/lab4", updated: 1 }],
      ["ses_new", { directory: "/home/jordan/lab4-b", updated: 2 }],
      ["web_1", { directory: "/nowhere", updated: 9 }],
    ])
    const projected = projectAssignment(CS310, read, locals, NOW)
    expect(projected.tasks.map((task) => [task.title, task.place])).toEqual([
      ["Task 1", "web"],
      ["Task 2", "jolli_code"],
    ])
    // A web task's chat is never one to continue here.
    expect(projected.tasks[0]?.local).toBeNull()
    expect(projected.tasks[1]?.local).toEqual({ sessionID: "ses_new", directory: "/home/jordan/lab4-b" })
    expect(projected.tasks[1]?.elsewhere).toBe(true)
    expect(taskSessionIDs(read)).toEqual(["ses_old", "ses_new", "ses_other_machine"])
  })

  /**
   * ⚠ A TASK'S ASSISTANT IS IN ITS COURSE'S ORG. A bare assistant id beside an org-scoped course id
   * names two orgs, which the start route refuses as no binding at all.
   */
  test("names a task's assistant in the org its course names", () => {
    const read = assignment([part({ assistantId: 12 })])
    expect(projectAssignment({ id: "acme:bio:7", code: "BIO 7" }, read, new Map(), NOW).tasks[0]?.assistantId).toBe(
      "acme:bio:12",
    )
    expect(projectAssignment(CS310, read, new Map(), NOW).tasks[0]?.assistantId).toBe("12")
  })

  test("names the session handed in, and is ready to turn in once every owed task is in", () => {
    const handed = part({
      attempts: [{ id: 2, conversationId: "ses_a", countedAt: "2026-10-20T10:00:00Z" }],
      submission: { attemptId: 2, submittedAt: "2026-10-21T10:00:00Z" },
    })
    const gone = part({ id: 43, assistantStatus: "deleted", owed: false })
    const projected = projectAssignment(CS310, assignment([handed, gone]), new Map(), NOW)
    expect(projected.tasks[0]?.handedInSessionID).toBe("ses_a")
    expect(projected.readyToTurnIn).toBe(true)
    expect(projected.tasksTotal).toBe(1)
    expect(handedInBy(projected, { assignmentId: "40", partId: "42" }, "ses_a")).toBe(true)
    expect(handedInBy(projected, { assignmentId: "40", partId: "42" }, "ses_b")).toBe(false)
  })

  /** ⚠ A TASK OF ANOTHER KIND HAS NO AGENT: LISTED AS DONE ON THE WEB, NEVER STARTED HERE. */
  test("lists a File upload task as a web task under its own name, and owes it before turning in", () => {
    const handed = part({
      attempts: [{ id: 2, conversationId: "ses_a", countedAt: "2026-10-20T10:00:00Z" }],
      submission: { attemptId: 2, submittedAt: "2026-10-21T10:00:00Z" },
    })
    const read = assignment([handed, filePart()])
    const projected = projectAssignment(CS310, read, new Map(), NOW)
    expect(projected.tasks[1]).toEqual({
      partId: "44",
      title: "Task 2",
      name: "Lab report",
      assistantId: null,
      assistantBlurb: null,
      place: "web",
      handedInAt: null,
      handedInSessionID: null,
      owed: true,
      local: null,
      elsewhere: false,
    })
    expect(taskDraftOf(projected, projected.tasks[1])).toBeUndefined()
    // The renderer names the task its own way, and the composer's label follows it.
    expect(taskDraftOf(projected, projected.tasks[0], "任务 1")?.label).toBe("Lab 4: Linked lists · 任务 1")
    expect(taskSessionIDs(read)).toEqual(["ses_a"])
    expect(projected).toMatchObject({ tasksHandedIn: 1, tasksTotal: 2, readyToTurnIn: false })
    const uploaded = filePart({ submission: { submittedAt: "2026-10-21T11:00:00Z" } })
    const done = projectAssignment(CS310, assignment([handed, uploaded]), new Map(), NOW)
    expect(done.tasks[1]?.handedInAt).toBe("2026-10-21T11:00:00Z")
    expect(done.readyToTurnIn).toBe(true)
  })

  test("is not ready to turn in with a task owed, once turned in, or past a due date it stops at", () => {
    const open = part()
    const handed = part({ submission: { attemptId: 2, submittedAt: "2026-10-21T10:00:00Z" } })
    expect(projectAssignment(CS310, assignment([open]), new Map(), NOW).readyToTurnIn).toBe(false)
    const turnedIn = assignment([handed], { progress: { ...progress, turnedInAt: "2026-10-22T10:00:00Z" } })
    expect(projectAssignment(CS310, turnedIn, new Map(), NOW)).toMatchObject({ turnedIn: true, readyToTurnIn: false })
    const stopped = assignment([handed], { dueAt: "2026-10-21T23:59:00Z" })
    expect(projectAssignment(CS310, stopped, new Map(), NOW).readyToTurnIn).toBe(false)
  })
})

describe("the hand-in permission", () => {
  test("lists what the gateway would keep, the reflection last and whole", () => {
    const reflection = `the empty list. ${"i kept fixing the loop ".repeat(30)}`
    const lines = handInLines({ ...preview, reflection })
    expect(lines).toEqual([
      "Lab 4: Linked lists · Task 2 · Prof. Okafor and CS 310 staff",
      "This chat up to now: 38 messages, with an AI summary",
      "Project: github.com/cs310-fall26/lab4-jordanlee · main · 3 commits (1 not pushed) · PR #3",
      `Reflection: “${reflection}”`,
    ])
  })

  test("says when the summary could not be written, and leaves out what the task does not ask for", () => {
    const lines = handInLines({
      ...preview,
      includes: { transcript: true, summary: true, reflection: false },
      summary: { kind: "failed", throughSeq: 77, reason: "timeout" },
      reflection: null,
      project: null,
    })
    expect(lines).toEqual([
      "Lab 4: Linked lists · Task 2 · Prof. Okafor and CS 310 staff",
      "This chat up to now: 38 messages, without an AI summary (it could not be written)",
    ])
  })

  /** ⚠ "ALLOW ALWAYS" REMEMBERS THE KEY, AND NO LINE OF A LATER REQUEST MAY EQUAL IT. */
  test("remembers one task by a key no line can match", () => {
    const key = taskApprovalKey("7", "40", "42")
    expect(key).not.toContain("*")
    expect(handInLines(preview)).not.toContain(key)
    expect(taskApprovalKey("7", "40", "43")).not.toBe(key)
  })

  test("only the two hand-in permissions are never approved without the student", () => {
    expect(isNeverAutoApproved(SUBMIT_TASK_PERMISSION)).toBe(true)
    expect(isNeverAutoApproved(TURN_IN_PERMISSION)).toBe(true)
    expect(isNeverAutoApproved("bash")).toBe(false)
  })

  test("a turn-in lists the assignment, who reviews it, and each task owed", () => {
    const handed = part({ submission: { attemptId: 2, submittedAt: "2026-10-21T10:00:00Z" } })
    const lines = turnInLines(projectAssignment(CS310, assignment([handed]), new Map(), NOW), "en-US")
    // The due date and the day handed in are the reader's own; only their form is fixed here.
    expect(lines[0]).toMatch(/^Lab 4: Linked lists · due Oct 2[45] · Prof\. Okafor$/)
    expect(lines[1]).toBe("Task 1 · CS 310 Lab Assistant · submitted Oct 21")
  })
})

describe("JolliAssignmentCache", () => {
  test("keeps a read for a minute, per student", () => {
    const read = assignment([part()])
    JolliAssignmentCache.keep("student-a", "7", read, NOW)
    expect(JolliAssignmentCache.assignment("student-a", "7", "40", NOW + 30_000)).toBe(read)
    expect(JolliAssignmentCache.assignment("student-b", "7", "40", NOW)).toBeUndefined()
    expect(JolliAssignmentCache.assignment("student-a", "7", "40", NOW + 61_000)).toBeUndefined()
  })

  /** ⚠ THE "HANDED IN" LABEL MUST CHANGE THE MOMENT THE STUDENT'S APPROVAL LANDS. */
  test("a hand-in replaces the part at once and drops the list", () => {
    JolliAssignmentCache.keep("student-a", "7", assignment([part()]), NOW)
    JolliAssignmentCache.putList("student-a", [], NOW)
    const handed = part({ submission: { attemptId: 2, submittedAt: "2026-10-22T11:00:00Z" } })
    JolliAssignmentCache.handedIn("student-a", "7", "40", handed, NOW)
    expect(JolliAssignmentCache.assignment("student-a", "7", "40", NOW)?.parts[0]?.submission).toEqual(
      handed.submission,
    )
    expect(JolliAssignmentCache.list("student-a", NOW)).toBeUndefined()
  })
})

describe("the assignment calls", () => {
  test("read a course's list and one assignment from the student's paths", async () => {
    const list = { todo: [listItem()], upcoming: [], completed: [] }
    const h = stub((request) =>
      request.url.endsWith("/assignments/student-view") ? json(list) : json(assignment([part()])),
    )
    const read = await Effect.runPromise(fetchStudentAssignments(REQUEST, 7).pipe(Effect.provide(h.layer)))
    expect(read.todo[0]?.tasks?.[1]?.workedIn).toBe("jolli_code")
    const one = await Effect.runPromise(fetchStudentAssignment(REQUEST, 7, 40).pipe(Effect.provide(h.layer)))
    expect(one.parts[0]).toMatchObject({ workedIn: "jolli_code" })
    expect(h.seen.map((request) => request.url)).toEqual([
      "https://acme.jolli.ai/api/courses/7/assignments/student-view",
      "https://acme.jolli.ai/api/courses/7/assignments/40/student-view",
    ])
  })

  /** ⚠ A PART WITH NO AGENT MUST NOT FAIL THE WHOLE ASSIGNMENT: ITS DIALOG, THE HAND-IN AND THE TURN-IN READ IT. */
  test("read an assignment with a File upload task, as the gateway sends one", async () => {
    const files = {
      id: 44,
      kind: "files",
      name: "Lab report",
      cardKey: "files-1",
      position: 1,
      reflectionPrompt: null,
      owed: true,
      fileTypes: null,
      maxFiles: 5,
      turnIn: { reflection: false },
      files: [],
      submission: null,
    }
    const h = stub(() => json({ ...assignment([]), parts: [part({ kind: "agent" }), files] }))
    const one = await Effect.runPromise(fetchStudentAssignment(REQUEST, 7, 40).pipe(Effect.provide(h.layer)))
    expect(one.parts.map((item) => (isAgentPart(item) ? "agent" : item.kind))).toEqual(["agent", "files"])
    expect(one.parts[1]).toMatchObject({ id: 44, name: "Lab report", submission: null, owed: true })
  })

  /** ⚠ BUT AN AGENT PART THAT FAILS ITS OWN SCHEMA FAILS THE READ, rather than pass for a web task. */
  test("an agent part missing an agent field fails the read instead of reading as another kind", async () => {
    // Every kind carries `name` on the wire, an agent part as well, so only its kind keeps it from the other.
    const broken = { ...part({ kind: "agent" }), name: "CS 310 Lab Assistant", assistantBlurb: null }
    const h = stub(() => json({ ...assignment([]), parts: [broken] }))
    await expect(
      Effect.runPromise(fetchStudentAssignment(REQUEST, 7, 40).pipe(Effect.provide(h.layer))),
    ).rejects.toBeDefined()
  })

  test("start a task's session under the client's id and read the opener", async () => {
    const h = stub(() => json({ config: { opener: { text: "Hi Jordan." } }, courseId: 7, courseAssistantId: 13 }, 201))
    const started = await Effect.runPromise(
      startTaskSession(REQUEST, { courseId: 7, assignmentId: 40, partId: 42, publicSessionId: "ses_a" }).pipe(
        Effect.provide(h.layer),
      ),
    )
    expect(started).toEqual({ opener: "Hi Jordan.", binding: { courseId: "7", assistantId: "13" } })
    expect(h.seen[0]?.url).toBe("https://acme.jolli.ai/api/courses/7/assignments/40/parts/42/jolli-code/sessions")
    expect(bodyOf(h.seen[0])).toEqual({ publicSessionId: "ses_a" })
    expect(h.seen[0]?.headers["x-jolli-assignment-participation"]).toBe("1")
  })

  test("preview and hand in send the same session, reflection and project; the hand-in names where to stop", async () => {
    const project = { remoteUrl: null, branch: "main", commits: [] }
    const h = stub((request) =>
      request.url.endsWith("/preview") ? json(preview) : json({ part: part(), owedCount: 0 }),
    )
    const ids = { courseId: 7, assignmentId: 40, partId: 42, publicSessionId: "ses_a", reflection: "why", project }
    const previewed = await Effect.runPromise(previewHandIn(REQUEST, ids).pipe(Effect.provide(h.layer)))
    expect(previewed.throughSeq).toBe(77)
    const handed = await Effect.runPromise(handIn(REQUEST, { ...ids, throughSeq: 77 }).pipe(Effect.provide(h.layer)))
    expect(handed.owedCount).toBe(0)
    expect(bodyOf(h.seen[0])).toEqual({ publicSessionId: "ses_a", reflection: "why", project })
    expect(bodyOf(h.seen[1])).toEqual({ publicSessionId: "ses_a", reflection: "why", project, throughSeq: 77 })
  })

  /** ⚠ THE SENTENCE IS THE GATEWAY'S, WITH ITS NEXT STEP; THE TOOL PASSES IT ON AS IT IS. */
  test("a refusal carries the gateway's code and its sentence", async () => {
    const sentence = "Your reflection has to be in your own words. Type it in the chat."
    const h = stub(() => json({ code: "reflection_not_students", error: sentence }, 400))
    const failed = await Effect.runPromise(
      Effect.flip(
        previewHandIn(REQUEST, { courseId: 7, assignmentId: 40, partId: 42, publicSessionId: "ses_a" }).pipe(
          Effect.provide(h.layer),
        ),
      ),
    )
    expect(failed).toBeInstanceOf(JolliApiError)
    expect(failed).toMatchObject({ status: 400, code: "reflection_not_students", explanation: sentence })
  })

  test("turn the assignment in at its own path", async () => {
    const h = stub(() => json(assignment([part()])))
    await Effect.runPromise(turnInAssignment(REQUEST, { courseId: 7, assignmentId: 40 }).pipe(Effect.provide(h.layer)))
    expect(h.seen[0]?.url).toBe("https://acme.jolli.ai/api/courses/7/assignments/40/turn-in")
    expect(h.seen[0]?.method).toBe("POST")
  })
})

describe("assignmentRefusalOf", () => {
  test("reads the gateway's sentence for an assignment's refused turn, and nothing else", () => {
    const sentence = "Lab 4 stopped taking work at its due date."
    expect(assignmentRefusalOf(JSON.stringify({ code: "assignment_turn_refused", error: sentence }))).toBe(sentence)
    expect(assignmentRefusalOf(JSON.stringify({ code: "assistant_closed", error: "x" }))).toBeUndefined()
    expect(assignmentRefusalOf("not json")).toBeUndefined()
  })
})

describe("turnInBlocker", () => {
  /** ⚠ THE STUDENT IS NOT ASKED TO APPROVE A TURN-IN THE GATEWAY WILL REFUSE. */
  test("names the tasks still to hand in, and where a web one is done", () => {
    const web = part({ id: 41, workedIn: "web_chat" })
    const handed = part({ submission: { attemptId: 2, submittedAt: "2026-10-21T10:00:00Z" } })
    const projected = projectAssignment(CS310, assignment([web, handed]), new Map(), NOW)
    expect(turnInBlocker(projected)).toBe(
      "Lab 4: Linked lists can't be turned in yet. Still to hand in: Task 1 (CS 310 Lab Assistant), which is done on the web.",
    )
  })

  test("says nothing once every owed task is in, and says so once it is turned in", () => {
    const handed = part({ submission: { attemptId: 2, submittedAt: "2026-10-21T10:00:00Z" } })
    expect(turnInBlocker(projectAssignment(CS310, assignment([handed]), new Map(), NOW))).toBeUndefined()
    const turned = assignment([handed], { progress: { ...progress, turnedInAt: "2026-10-22T10:00:00Z" } })
    expect(turnInBlocker(projectAssignment(CS310, turned, new Map(), NOW))).toBe(
      "Lab 4: Linked lists is already turned in.",
    )
  })
})
