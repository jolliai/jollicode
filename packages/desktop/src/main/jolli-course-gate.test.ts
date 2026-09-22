import { describe, expect, test } from "bun:test"
import { checkCourseGate } from "./jolli-course-gate"
import type { SidecarCall } from "./jolli-sidecar"

/**
 * ⚠ THE DISTINCTION UNDER TEST IS "NO COURSES" VERSUS "NOBODY COULD BE ASKED", and it is the only
 * thing this module decides. Everything else — the credential, the allowlist, the stale-snapshot
 * fallback — moved to the server, which is why this is now a stub of one HTTP call rather than a
 * temp cache directory.
 *
 * ⚠ THE ONE-MACHINE-TWO-STUDENTS PROPERTY MOVED WITH IT. It used to live here because the token
 * did; it is now a property of the credential row and the cache key derived from it, and it is
 * pinned in `packages/core/test/jolli-store.test.ts` and `jolli-session.test.ts`.
 */
const answering = (body: unknown): SidecarCall => (async () => body) as SidecarCall

const failing: SidecarCall = (async () => {
  throw new Error("connection refused")
}) as SidecarCall

describe("checkCourseGate", () => {
  test("no server yet is a question we never got to ask", async () => {
    expect(await checkCourseGate(undefined)).toEqual({ kind: "unreachable" })
  })

  test("a server that cannot be reached is unreachable, not empty", async () => {
    // Reporting "none of your courses use Jolli Code" here sends a student to their registrar over
    // a Wi-Fi problem.
    expect(await checkCourseGate(failing)).toEqual({ kind: "unreachable" })
  })

  test("passes the server's own unreachable through rather than reinterpreting it", async () => {
    expect(await checkCourseGate(answering({ status: "unreachable", courses: [] }))).toEqual({ kind: "unreachable" })
  })

  test("an answered but empty catalogue is none", async () => {
    expect(await checkCourseGate(answering({ status: "ok", courses: [] }))).toEqual({ kind: "none" })
  })

  test("any course at all opens the gate", async () => {
    // Including a draft one: the picker can say "your instructor hasn't published this yet" and the
    // gate cannot.
    expect(await checkCourseGate(answering({ status: "ok", courses: [{ id: 1 }] }))).toEqual({ kind: "ok" })
  })
})
