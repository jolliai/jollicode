import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { checkCourseGate } from "./jolli-course-gate"

/**
 * ⚠ THESE DRIVE THE REAL CACHE FILE RATHER THAN A STUB, because the distinction under test is
 * exactly the one the cache draws: "the gateway said you have no courses" versus "nobody could be
 * asked". A mocked loader would let that collapse without the test noticing.
 */
const roots: string[] = []
const original = { xdg: process.env["XDG_CACHE_HOME"], url: process.env["JOLLI_URL"] }

async function cacheRoot() {
  const root = await mkdtemp(join(tmpdir(), "jolli-gate-"))
  roots.push(root)
  process.env["XDG_CACHE_HOME"] = root
  return root
}

afterEach(async () => {
  if (original.xdg === undefined) delete process.env["XDG_CACHE_HOME"]
  else process.env["XDG_CACHE_HOME"] = original.xdg
  if (original.url === undefined) delete process.env["JOLLI_URL"]
  else process.env["JOLLI_URL"] = original.url
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const session = { token: "jwt", baseUrl: "https://acme.jolli.ai" }

describe("checkCourseGate", () => {
  test("a student who is not signed in cannot be asked", async () => {
    expect(await checkCourseGate(undefined)).toEqual({ kind: "unreachable" })
  })

  // An older backend did not report a tenant on exchange, so there is nowhere to send the question.
  test("no tenant is unreachable rather than empty", async () => {
    expect(await checkCourseGate({ token: "jwt" })).toEqual({ kind: "unreachable" })
  })

  test("a host outside the allowlist is refused rather than called", async () => {
    expect(await checkCourseGate({ token: "jwt", baseUrl: "https://evil.example" })).toEqual({ kind: "unreachable" })
  })

  /**
   * ⚠ THE LOAD-BEARING CASE. With no cache and no reachable gateway the answer must be
   * "unreachable" — reporting "none" would tell a student their enrolment is empty because their
   * Wi-Fi dropped, and send them to a registrar over a network fault.
   */
  test("an unreachable gateway with nothing cached is not reported as having no courses", async () => {
    await cacheRoot()
    process.env["JOLLI_URL"] = "https://acme.jolli.ai"
    expect(await checkCourseGate({ token: "jwt", baseUrl: "https://nonexistent.jolli.ai" })).toEqual({
      kind: "unreachable",
    })
  }, 30_000)
})

/**
 * ⚠ THESE WRITE THE REAL CACHE FILE, because `Global.Path.cache` is resolved when the module is
 * imported and so cannot be redirected from a test. The tenant below exists only here, so its
 * cache key collides with nothing; a fresh file is served without any request, which is also what
 * makes these two cases testable without a gateway.
 */
const TENANT = "https://gate-test.jolli.ai"
const TOKEN = "jwt"
/** ⚠ The key carries the credential, so two students on one machine cannot read each other's. */
const cacheFile = join(Global.Path.cache, `jolli-catalog-${Hash.fast(`${TENANT}||${TOKEN}`)}.json`)

async function seedCache(courses: unknown[]) {
  await mkdir(Global.Path.cache, { recursive: true })
  // The stamp is what makes a snapshot readable; see `cache.ts`'s SCHEMA.
  await writeFile(cacheFile, JSON.stringify({ schema: 1, courses, assistants: {}, models: [] }))
  roots.push(cacheFile)
}

describe("checkCourseGate — against a cached catalogue", () => {
  test("a student with a course is let in", async () => {
    await seedCache([{ id: 7, code: "CS 310", status: "published", requiresCoding: true }])
    expect(await checkCourseGate({ token: TOKEN, baseUrl: TENANT })).toEqual({ kind: "ok" })
  })

  /**
   * ⚠ EMPTY MEANS EMPTY ONLY BECAUSE THE GATEWAY ANSWERED. The cache holds courses that already
   * passed the hard filter, so an empty one is Jolli saying "none of yours are coding courses" —
   * which is a different sentence from the unreachable case above, and the only one that should
   * send a student to their instructor.
   */
  test("a student whose filtered list is empty is stopped, and told so", async () => {
    await seedCache([])
    expect(await checkCourseGate({ token: TOKEN, baseUrl: TENANT })).toEqual({ kind: "none" })
  })

  // A draft-only course still counts: the picker can explain it, the gate cannot.
  test("a course that cannot be started yet still opens the gate", async () => {
    await seedCache([{ id: 8, code: "CS 101", status: "draft", requiresCoding: true }])
    expect(await checkCourseGate({ token: TOKEN, baseUrl: TENANT })).toEqual({ kind: "ok" })
  })
})

describe("checkCourseGate — one machine, two students", () => {
  /**
   * ⚠ THE LEAK THIS GUARDS. A lab bench or a loaner laptop puts two students on one cache, and the
   * gate's own "use a different account" button makes the swap a supported flow. Keyed by tenant
   * alone, the second student was served the first one's courses — and their model catalogue was
   * baked into the second student's sidecar.
   */
  test("a second student does not read the first one's snapshot", async () => {
    await seedCache([{ id: 7, code: "CS 310", status: "published", requiresCoding: true }])
    expect(await checkCourseGate({ token: TOKEN, baseUrl: TENANT })).toEqual({ kind: "ok" })

    // Same tenant, different credential: no cache of their own, and the gateway is unreachable.
    expect(await checkCourseGate({ token: "somebody-else", baseUrl: TENANT })).toEqual({
      kind: "unreachable",
    })
  }, 30_000)
})
