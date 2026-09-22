import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpApiError } from "effect/unstable/httpapi"
import {
  preserveBinding,
  refuseRebindingAfterFirstMessage,
} from "../../src/server/routes/instance/httpapi/handlers/session"

const bound = (courseId: string, assistantId: string, sharing = { staff: false, everyone: false }) => ({
  jolli: { courseId, assistantId, sharing },
})

/**
 * ⚠ THE PROBE ANSWERS "HAS IT STARTED", NOT "WHAT WAS SAID LAST". An earlier guard asked for one
 * message and checked its ROLE, which pages from newest-first and so saw the assistant's reply in
 * every steady-state conversation — the check passed and the lock never engaged on a single
 * session it was meant to protect. There is no role here any more because there is nothing a role
 * could correctly decide.
 */
const started = () => Effect.succeed(true)
const noMessages = () => Effect.succeed(false)
const unreadable = () => Effect.fail(new Error("storage is down")) as Effect.Effect<boolean, unknown>
/**
 * ⚠ THE SHAPE THE REAL CALLER ACTUALLY PRODUCES. `MessageV2.exists` reads the database through
 * `Effect.orDie`, so a database that will not answer is a DEFECT rather than a typed failure — and
 * a guard that caught only failures let it past, killing the request instead of refusing the write.
 */
const broken = () => Effect.die(new Error("the database is gone")) as Effect.Effect<boolean, unknown>

const run = (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown>,
  hasMessages: () => Effect.Effect<boolean, unknown> = started,
) => Effect.runPromise(Effect.exit(refuseRebindingAfterFirstMessage(before, after, hasMessages)))

const refused = async (...args: Parameters<typeof run>) => (await run(...args))._tag === "Failure"

describe("refuseRebindingAfterFirstMessage", () => {
  test("refuses a course change once a user message exists", async () => {
    expect(await refused(bound("7", "12"), bound("8", "20"))).toBe(true)
  })

  test("refuses an assistant change too", async () => {
    expect(await refused(bound("7", "12"), bound("7", "13"))).toBe(true)
  })

  /**
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR. Visibility lives in the same `jolli` object and IS the
   * student's to change on a live session. Comparing the object wholesale refused every privacy
   * toggle after the first message — the one part of a binding this lock must not cover.
   */
  test("allows a visibility change on a session that has started", async () => {
    expect(await refused(bound("7", "12"), bound("7", "12", { staff: true, everyone: false }))).toBe(false)
  })

  test("allows an identical rewrite, so an idempotent retry is not an error", async () => {
    expect(await refused(bound("7", "12"), bound("7", "12"))).toBe(false)
  })

  // Metadata is a bag shared with other features; they write to live sessions all the time.
  test("ignores writes that do not touch the binding", async () => {
    expect(await refused({ ...bound("7", "12"), other: 1 }, { ...bound("7", "12"), other: 2 })).toBe(false)
  })

  /**
   * ⚠ THE LINE IS THE FIRST MESSAGE, NOT THE SESSION'S EXISTENCE. A session the CLI created and
   * left, or one a crash left half-made, is still bindable.
   */
  test("allows binding a session that has not been spoken to", async () => {
    expect(await refused(bound("7", "12"), bound("8", "20"), noMessages)).toBe(false)
    expect(await refused(undefined, bound("7", "12"), noMessages)).toBe(false)
    expect(await refused({}, bound("7", "12"), noMessages)).toBe(false)
  })

  // The regression: an answered session is the normal case, and it must still be locked.
  test("stays locked on a session that has any message at all", async () => {
    expect(await refused(bound("7", "12"), bound("8", "20"), started)).toBe(true)
  })

  // A lock that cannot read its own precondition must refuse, not wave things through.
  test("refuses when the messages cannot be read", async () => {
    expect(await refused(bound("7", "12"), bound("8", "20"), unreadable)).toBe(true)
  })

  test("refuses with BadRequest when the read DIES rather than fails", async () => {
    const exit = await run(bound("7", "12"), bound("8", "20"), broken)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      // Not merely "did not succeed": an escaping defect is a 500, and the lock's own 400 is gone.
      expect(String(exit.cause)).toContain(HttpApiError.BadRequest.name ?? "BadRequest")
      expect(String(exit.cause)).not.toContain("the database is gone")
    }
  })

  /**
   * ⚠ A SESSION THAT STARTED UNBOUND IS NOT A FREE-FOR-ALL, and an earlier cut of this guard
   * returned early whenever there was no previous binding. The TUI and `opencode run` create
   * sessions with no metadata at all, so a conversation can run to completion unbound and then be
   * handed a course — which re-scopes a finished transcript under terms that did not apply while
   * it was being written. That is the same harm as a rewrite, so it gets the same answer.
   */
  test("refuses a FIRST binding once the session has started", async () => {
    expect(await refused(undefined, bound("7", "12"))).toBe(true)
    expect(await refused({}, bound("7", "12"))).toBe(true)
    expect(await refused({ other: 1 }, { ...bound("7", "12"), other: 1 })).toBe(true)
  })

  // Neither side bound is not a binding change, so an ordinary metadata write stays free.
  test("lets an unbound session take unrelated metadata while started", async () => {
    expect(await refused({}, { other: 1 })).toBe(false)
    expect(await refused(undefined, {})).toBe(false)
  })

  /**
   * A binding shaped wrong is no binding, so writing a real one over it is a first bind — which is
   * refused on a started session for the reason above, and allowed before it starts.
   */
  test("malformed existing metadata counts as unbound", async () => {
    expect(await refused({ jolli: "nonsense" }, bound("7", "12"), noMessages)).toBe(false)
    expect(await refused({ jolli: { courseId: 7 } }, bound("7", "12"), noMessages)).toBe(false)
    expect(await refused({ jolli: "nonsense" }, bound("7", "12"))).toBe(true)
  })

  // Dropping the binding entirely is still a rebind, and still refused once started.
  test("refuses removing the binding from a started session", async () => {
    expect(await refused(bound("7", "12"), {})).toBe(true)
  })

  test("fails with BadRequest rather than dying", async () => {
    const exit = await run(bound("7", "12"), bound("8", "20"))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain(HttpApiError.BadRequest.name ?? "BadRequest")
    }
  })
})

describe("preserveBinding", () => {
  /**
   * ⚠ `setMetadata` REPLACES THE WHOLE BAG, so a feature writing its own key would unbind every
   * session it touched. Re-attaching the existing binding is what lets the guard's own comment —
   * "metadata is a shared bag" — actually be true.
   */
  test("an unrelated write keeps the binding it never mentioned", () => {
    expect(preserveBinding(bound("7", "12"), { somethingElse: 1 })).toEqual({
      somethingElse: 1,
      jolli: bound("7", "12").jolli,
    })
  })

  test("a write that carries a binding is left alone, so the guard can judge it", () => {
    expect(preserveBinding(bound("7", "12"), bound("8", "20"))).toEqual(bound("8", "20"))
  })

  test("an unbound session gains nothing", () => {
    expect(preserveBinding(undefined, { a: 1 })).toEqual({ a: 1 })
    expect(preserveBinding({}, { a: 1 })).toEqual({ a: 1 })
  })
})
