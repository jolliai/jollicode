import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { GatewayRequest, HandInPreview } from "@opencode-ai/core/jolli/api"
import { HAND_IN_ELSEWHERE, SUBMIT_TASK_PERMISSION, TURN_IN_PERMISSION } from "@opencode-ai/core/jolli/assignment"
import { JolliAssignmentCache } from "@opencode-ai/core/jolli/assignment-cache"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { EffectBridge } from "@/effect/bridge"
import { Git } from "@/git"
import { JolliAssignmentPlugin } from "@/plugin/jolli-assignment"
import { Session } from "@/session/session"

afterEach(() => JolliAssignmentCache.reset())

const REQUEST: GatewayRequest = { origin: "https://acme.jolli.ai", token: "jwt", identity: "student-a" }
const TASK_SESSION = {
  id: "ses_a",
  directory: "/home/jordan/lab4",
  time: { created: 1, updated: 2 },
  metadata: {
    jolli: { courseId: "7", assistantId: "13" },
    jolliTask: { sessionID: "ses_a", assignmentId: "40", partId: "42", startHead: "9f0c1aa" },
  },
}

const preview: HandInPreview = {
  assignmentTitle: "Lab 4: Linked lists",
  taskTitle: "Task 2",
  staffLabel: "Prof. Okafor and CS 310 staff",
  messageCount: 38,
  throughSeq: 77,
  includes: { transcript: true, summary: false, reflection: true },
  summary: null,
  reflectionPrompt: "What was the hardest bug?",
  reflection: "the empty list. i kept fixing the loop",
  project: null,
}

const part = {
  id: 42,
  assistantId: 13,
  assistantName: "CS 310 Lab Assistant",
  assistantBlurb: "",
  assistantStatus: "live",
  turnIn: { transcript: true, summary: false, reflection: true },
  reflectionPrompt: null,
  workedIn: "jolli_code",
  attempts: [{ id: 2, conversationId: "ses_a", countedAt: "2026-10-20T10:00:00Z" }],
  submission: { attemptId: 2, submittedAt: "2026-10-22T10:00:00Z" },
  owed: true,
}

/** The assignment as the gateway reads it back: its one task handed in under `ses_a`. */
const assignment = {
  id: 40,
  courseId: 7,
  title: "Lab 4: Linked lists",
  description: "",
  opensAt: null,
  dueAt: null,
  stopAtDue: false,
  status: "published",
  progress: { state: "ready_to_turn_in", partsSubmitted: 1, partsTotal: 1, turnedInAt: null },
  authorName: "Prof. Okafor",
  parts: [part],
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/**
 * A bridge over the four things the tools reach: the session, the credential, git, and the gateway.
 * Git answers "not a repository", so no project is reported; the gateway is a stubbed `fetch`.
 */
function harness(
  answer: (url: string, body: unknown) => Response,
  metadata: Record<string, unknown> = TASK_SESSION.metadata,
) {
  const sent: { url: string; body: unknown }[] = []
  const projectReads: string[] = []
  /** The org each call was scoped to, in the order sent; null for a call with no scope. */
  const orgs: (string | null)[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    orgs.push(new Headers(input instanceof Request ? input.headers : init?.headers).get("x-org-slug"))
    const url = input instanceof Request ? input.url : String(input)
    const raw = input instanceof Request ? await input.text() : init?.body
    const body =
      typeof raw === "string" && raw
        ? JSON.parse(raw)
        : raw instanceof Uint8Array
          ? JSON.parse(new TextDecoder().decode(raw))
          : undefined
    sent.push({ url, body })
    return answer(url, body)
  }) as typeof globalThis.fetch
  const services = Layer.mergeAll(
    Layer.mock(Session.Service)({
      get: () => Effect.succeed({ ...TASK_SESSION, metadata } as unknown as Session.Info),
    }),
    Layer.mock(JolliSession.Service)({
      request: () => Effect.succeed(REQUEST),
      refused: (token: string) => Effect.succeed(token),
    }),
    Layer.mock(Git.Service)({
      run: () =>
        Effect.succeed({
          exitCode: 128,
          text: () => "",
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          truncated: false,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              projectReads.push("project")
            }),
          ),
        ),
    }),
    Layer.succeed(FetchHttpClient.Fetch, fetch),
  )
  const bridge = {
    promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services)) as Effect.Effect<A, E>),
  } as unknown as EffectBridge.Shape
  return { bridge, sent, orgs, projectReads }
}

function context(ask: ToolContext["ask"], abort = new AbortController().signal): ToolContext {
  return {
    sessionID: "ses_a",
    messageID: "msg_a",
    agent: "build",
    directory: "/home/jordan/lab4",
    worktree: "/home/jordan/lab4",
    abort,
    metadata: () => undefined,
    ask,
  }
}

async function tools(h: ReturnType<typeof harness>) {
  const hooks = await JolliAssignmentPlugin({} as PluginInput, { bridge: h.bridge })
  return hooks.tool!
}

const output = (result: unknown) => (typeof result === "string" ? result : (result as { output: string }).output)

describe("plugin.jolli-assignment: handing a task in", () => {
  test("a cached Submit tool rechecks participation before project collection or permission", async () => {
    const h = harness(() =>
      json({
        ...assignment,
        parts: [{ ...part, turnIn: { transcript: false, summary: false, reflection: false }, submission: null }],
      }),
    )
    const asked: string[] = []
    const result = await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => {
        asked.push("asked")
      }),
    )
    expect(output(result)).toStartWith("Nothing to turn in.")
    expect(asked).toEqual([])
    expect(h.projectReads).toEqual([])
    expect(h.sent.map((item) => item.url)).toEqual(["https://acme.jolli.ai/api/courses/7/assignments/40/student-view"])
  })

  test("asks the student with the gateway's preview, then hands in up to where the preview ended", async () => {
    const h = harness((url) => (url.endsWith("/preview") ? json(preview) : json({ part, owedCount: 0 })))
    const asked: Parameters<ToolContext["ask"]>[0][] = []
    const result = await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      { reflection: "the empty list. i kept fixing the loop" },
      context(async (request) => {
        asked.push(request)
      }),
    )

    expect(asked).toHaveLength(1)
    expect(asked[0]?.permission).toBe(SUBMIT_TASK_PERMISSION)
    expect(asked[0]?.patterns).toEqual([
      "Lab 4: Linked lists · Task 2 · Prof. Okafor and CS 310 staff",
      "This chat up to now: 38 messages",
      "Reflection: “the empty list. i kept fixing the loop”",
    ])
    expect(asked[0]?.always).toEqual(["course 7 assignment 40 task 42"])
    expect(asked[0]?.metadata.preview).toEqual(preview)

    expect(h.sent.map((item) => item.url)).toEqual([
      "https://acme.jolli.ai/api/courses/7/assignments/40/student-view",
      "https://acme.jolli.ai/api/courses/7/assignments/40/parts/42/jolli-code/preview",
      "https://acme.jolli.ai/api/courses/7/assignments/40/parts/42/jolli-code/hand-in",
    ])
    expect(h.sent[2]?.body).toEqual({
      publicSessionId: "ses_a",
      reflection: "the empty list. i kept fixing the loop",
      throughSeq: 77,
    })
    // The last task in: the agent is told to offer the turn-in.
    expect(output(result)).toContain("ask the student whether to turn the whole assignment in")
  })

  test("an org-scoped task is previewed and handed in in its org, by the numeric ids", async () => {
    const h = harness((url) => (url.endsWith("/preview") ? json(preview) : json({ part, owedCount: 0 })), {
      ...TASK_SESSION.metadata,
      jolli: { courseId: "acme:main:7", assistantId: "acme:main:13" },
    })
    await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => undefined),
    )
    expect(h.sent.map((item) => item.url)).toEqual([
      "https://acme.jolli.ai/api/courses/7/assignments/40/student-view",
      "https://acme.jolli.ai/api/courses/7/assignments/40/parts/42/jolli-code/preview",
      "https://acme.jolli.ai/api/courses/7/assignments/40/parts/42/jolli-code/hand-in",
    ])
    expect(h.sent[2]?.body).toMatchObject({ publicSessionId: "ses_a" })
    expect(h.orgs).toEqual(["main", "main", "main"])
  })

  test("a bare task sends no scope", async () => {
    const h = harness((url) => (url.endsWith("/preview") ? json(preview) : json({ part, owedCount: 0 })))
    await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => undefined),
    )
    expect(h.orgs).toEqual([null, null, null])
  })

  /** ⚠ A NO FROM THE STUDENT IS AN ANSWER: nothing goes in, and the agent keeps talking. */
  test("hands nothing in when the student declines, and passes on what they said", async () => {
    for (const [error, said] of [
      [new PermissionV1.RejectedError(), undefined],
      [new PermissionV1.DeniedError({ ruleset: [] }), undefined],
      [new PermissionV1.CorrectedError({ feedback: "wait, one more test" }), "wait, one more test"],
    ] as const) {
      const h = harness(() => json(preview))
      const result = await (
        await tools(h)
      )[SUBMIT_TASK_PERMISSION].execute(
        {},
        context(async () => {
          throw error
        }),
      )
      expect(output(result)).toStartWith("The student declined. Nothing was handed in.")
      if (said) expect(output(result)).toContain(said)
      expect(h.sent).toHaveLength(2)
    }
  })

  /** ⚠ A RUN OR AN EDITOR THAT CANNOT ASK THE STUDENT SAYS WHERE TO HAND IN; THE AGENT PASSES IT ON. */
  test("a surface that cannot ask says where to hand in instead", async () => {
    const h = harness(() => json(preview))
    const result = await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => {
        throw new PermissionV1.CorrectedError({ feedback: HAND_IN_ELSEWHERE })
      }),
    )
    expect(output(result)).toBe(`Nothing was handed in. ${HAND_IN_ELSEWHERE}`)
  })

  test("the session being stopped is not a decline", async () => {
    const h = harness(() => json(preview))
    const stopped = new Error("aborted")
    const run = (await tools(h))[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => {
        throw stopped
      }),
    )
    expect(
      await run.then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBe(stopped)
  })

  /** ⚠ THE PREVIEW CAN TAKE A MINUTE AND A HALF; A TURN STOPPED MEANWHILE ASKS NOBODY. */
  test("a turn stopped during the preview asks nothing and hands nothing in", async () => {
    const stop = new AbortController()
    const h = harness(() => {
      stop.abort()
      return json(preview)
    })
    let asked = false
    const result = await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => {
        asked = true
      }, stop.signal),
    )
    expect(output(result)).toBe("The student stopped this turn. Nothing was handed in.")
    expect(asked).toBe(false)
    expect(h.sent).toHaveLength(1)
  })

  /**
   * ⚠ ONLY A REFUSAL PROVES NOTHING WENT IN. A 5xx, a timeout or an unreadable answer may come after
   * the gateway kept the hand-in, so the tool reads the assignment again and answers from that.
   */
  describe("a hand-in the gateway did not confirm", () => {
    const notHandedIn = { ...part, submission: null, attempts: [] }
    const unsure = (reread: () => Response) =>
      harness((url) => {
        if (url.endsWith("/preview")) return json(preview)
        if (url.endsWith("/hand-in")) return json({}, 504)
        return reread()
      })
    const submit = async (h: ReturnType<typeof harness>) =>
      output(
        await (
          await tools(h)
        )[SUBMIT_TASK_PERMISSION].execute(
          {},
          context(async () => undefined),
        ),
      )

    test("is reported handed in when the assignment read again says it went in", async () => {
      const h = unsure(() => json(assignment))
      expect(await submit(h)).toStartWith("Handed in Lab 4: Linked lists · Task 2.")
      expect(h.sent.at(-1)?.url).toEndWith("/assignments/40/student-view")
    })

    test("is reported not handed in when the assignment read again says so", async () => {
      const h = unsure(() =>
        json({ ...assignment, parts: [notHandedIn], progress: { ...assignment.progress, partsSubmitted: 0 } }),
      )
      expect(await submit(h)).toBe("Jolli couldn't be reached, so nothing was handed in. Try again in a minute.")
    })

    test("tells the student to look first when the assignment cannot be read either", async () => {
      JolliAssignmentCache.keep(REQUEST.identity, "7", assignment as never, Date.now())
      const h = unsure(() => json({}, 503))
      const said = await submit(h)
      expect(said).toContain("Don't call this tool again yet")
      expect(said).not.toContain("Nothing was handed in")
      expect(JolliAssignmentCache.assignment(REQUEST.identity, "7", "40", Date.now())).toBeUndefined()
    })

    test("a refusal is taken at its word, without reading again", async () => {
      const h = harness((url) => (url.endsWith("/preview") ? json(preview) : json({}, 409)))
      expect(await submit(h)).toBe("Jolli refused the hand-in. Nothing was handed in.")
      expect(h.sent).toHaveLength(3)
    })
  })

  test("a refused preview is passed on in the gateway's words, and nothing is asked", async () => {
    const sentence = "Your reflection has to be in your own words. Type it in the chat, then ask me again."
    const h = harness(() => json({ code: "reflection_not_students", error: sentence }, 400))
    let asked = false
    const result = await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      { reflection: "my own summary" },
      context(async () => {
        asked = true
      }),
    )
    expect(output(result)).toBe(sentence)
    expect(asked).toBe(false)
  })

  test("a session no task started hands nothing in and asks nobody", async () => {
    const h = harness(() => json(preview), { jolli: { courseId: "7", assistantId: "13" } })
    const result = await (
      await tools(h)
    )[SUBMIT_TASK_PERMISSION].execute(
      {},
      context(async () => undefined),
    )
    expect(output(result)).toContain("wasn't started from an assignment task")
    expect(h.sent).toEqual([])
  })
})

describe("plugin.jolli-assignment: turning the assignment in", () => {
  test("asks with the assignment and its tasks, then turns it in", async () => {
    const h = harness(() => json(assignment))
    const asked: Parameters<ToolContext["ask"]>[0][] = []
    const result = await (
      await tools(h)
    )[TURN_IN_PERMISSION].execute(
      {},
      context(async (request) => {
        asked.push(request)
      }),
    )
    expect(asked[0]?.permission).toBe(TURN_IN_PERMISSION)
    expect(asked[0]?.patterns[0]).toBe("Lab 4: Linked lists · Prof. Okafor")
    expect(asked[0]?.always).toEqual(["course 7 assignment 40"])
    expect(h.sent.map((item) => item.url)).toEqual([
      "https://acme.jolli.ai/api/courses/7/assignments/40/student-view",
      "https://acme.jolli.ai/api/courses/7/assignments/40/turn-in",
    ])
    expect(output(result)).toBe("Turned in Lab 4: Linked lists.")
  })

  test("turns nothing in when the student declines", async () => {
    const h = harness(() => json(assignment))
    const result = await (
      await tools(h)
    )[TURN_IN_PERMISSION].execute(
      {},
      context(async () => {
        throw new PermissionV1.RejectedError()
      }),
    )
    expect(output(result)).toStartWith("The student declined. Nothing was turned in.")
    expect(h.sent).toHaveLength(1)
  })
  test("a turn-in the gateway did not confirm is settled by reading the assignment again", async () => {
    let reads = 0
    const h = harness((url) => {
      if (url.endsWith("/turn-in")) return json({}, 504)
      reads += 1
      return json(
        reads === 1
          ? assignment
          : { ...assignment, progress: { ...assignment.progress, turnedInAt: "2026-10-23T10:00:00Z" } },
      )
    })
    const result = await (
      await tools(h)
    )[TURN_IN_PERMISSION].execute(
      {},
      context(async () => undefined),
    )
    expect(output(result)).toBe("Turned in Lab 4: Linked lists.")
  })

  test("a failure says nothing was turned in, not handed in", async () => {
    for (const [answer, said] of [
      [() => json({}, 503), "Jolli couldn't be reached, so nothing was turned in. Try again in a minute."],
      [
        (url: string) => (url.endsWith("/turn-in") ? json({}, 400) : json(assignment)),
        "Jolli refused the turn-in. Nothing was turned in.",
      ],
    ] as const) {
      const h = harness(answer)
      const result = await (
        await tools(h)
      )[TURN_IN_PERMISSION].execute(
        {},
        context(async () => undefined),
      )
      expect(output(result)).toBe(said)
    }
  })
})
