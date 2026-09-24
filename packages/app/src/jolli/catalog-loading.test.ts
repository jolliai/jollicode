import { beforeEach, describe, expect, test } from "bun:test"
import {
  assistantById,
  catalogGeneration,
  courseById,
  ensureCatalog,
  enrolledCourses,
  ready,
  resetCatalog,
  viewer,
} from "./catalog"
import { modelTier } from "./model-tier"
import type { Catalog } from "./types"

const catalog: Catalog = {
  // A catalogue the gateway actually answered — see `Jolli.CatalogStatus`.
  status: "ok",
  courses: [
    {
      id: "7",
      code: "CS 310",
      title: "Systems Programming",
      kind: "code",
      accent: 1,
      assistantIds: ["12"],
      status: "published",
      entryState: "open",
      endsOn: null,
    },
  ],
  assistants: [
    {
      id: "12",
      courseId: "7",
      name: "Pair programmer",
      kind: "code",
      icon: "Sparkles",
      blurb: "",
      accent: 1,
      isDefault: true,
      instructions: "",
      allowedModelIds: ["jolli/uuid-opus"],
      guardrails: { neverGiveDirectAnswers: true, restrictToMaterials: false, showCitations: true, weeklyTokenCap: 0 },
      coaching: { coachTheQuestion: true, coachTheProcess: true, coachTheModelChoice: true, instructions: "" },
      skills: [],
      status: "live",
    },
  ],
  modelTiers: { "jolli/uuid-opus": "premium" },
}

beforeEach(() => resetCatalog())

describe("ensureCatalog", () => {
  /**
   * ⚠ THREE THINGS ASK ON EVERY LAUNCH — `CourseSessionProvider` on the new-session route and
   * inside the directory layout, and `ServerScopedProviders` from above both — so this is not a
   * micro-optimisation: bare fetches would race each other into the store.
   */
  test("asks once however many screens ask, and shares the one answer", async () => {
    let calls = 0
    const load = () => {
      calls++
      return Promise.resolve(catalog)
    }
    await Promise.all([ensureCatalog("server-a", load), ensureCatalog("server-a", load)])
    await ensureCatalog("server-a", load)

    expect(calls).toBe(1)
    expect(ready()).toBe(true)
    expect(enrolledCourses().map((c) => c.code)).toEqual(["CS 310"])
    expect(assistantById("12")?.name).toBe("Pair programmer")
    expect(assistantById(undefined)).toBeUndefined()
  })

  /**
   * ⚠ A FAILURE IS NOT CACHED. The catalogue is what the course picker is made of; if the first
   * attempt lost a race with the sidecar coming up, the next screen to ask must get a real attempt
   * rather than a remembered empty list.
   */
  test("a failed load is retried by the next asker", async () => {
    let calls = 0
    const failing = () => {
      calls++
      return Promise.reject(new Error("sidecar is still coming up"))
    }
    await ensureCatalog("server-a", failing)
    expect(ready()).toBe(false)

    await ensureCatalog("server-a", failing)
    expect(calls).toBe(2)

    await ensureCatalog("server-a", () => Promise.resolve(catalog))
    expect(enrolledCourses().length).toBe(1)
  })

  /**
   * ⚠ `unreachable` ARRIVES AS A 200 WITH AN EMPTY CATALOGUE — no credential, no tenant, a gateway
   * that did not reply. Cached as an answer it would leave `inFlight` resolved and hand the student
   * an empty course picker for the life of the process, with no screen able to ask again.
   */
  test("an unreachable answer is not cached and the next asker retries", async () => {
    let calls = 0
    const unreachable = () => {
      calls++
      return Promise.resolve({ status: "unreachable", courses: [], assistants: [], modelTiers: {} } satisfies Catalog)
    }
    await ensureCatalog("server-a", unreachable)
    expect(enrolledCourses()).toEqual([])

    await ensureCatalog("server-a", unreachable)
    expect(calls).toBe(2)

    await ensureCatalog("server-a", () => Promise.resolve(catalog))
    expect(ready()).toBe(true)
    expect(enrolledCourses().map((c) => c.code)).toEqual(["CS 310"])
  })

  /**
   * ⚠ THE IDENTITY ON AN UNREACHABLE ANSWER IS NOT PART OF THE FAILURE. The server resolves the
   * viewer from the stored token before it asks whether the gateway is reachable, precisely so a
   * name on screen does not depend on the network — and the client used to throw that away with
   * the empty course list it came beside, blanking the student's own name on every offline launch.
   */
  test("keeps the identity an unreachable answer carries, and none of its courses", async () => {
    await ensureCatalog("server-a", () => Promise.resolve(catalog))

    await ensureCatalog(`server-a#1`, () =>
      Promise.resolve({
        status: "unreachable",
        courses: [],
        assistants: [],
        modelTiers: {},
        viewer: { name: "Ada Lovelace" },
      } satisfies Catalog),
    )

    expect(viewer()?.name).toBe("Ada Lovelace")
    // The courses are what we could not ask about; the ones already on screen stay there.
    expect(enrolledCourses().map((c) => c.code)).toEqual(["CS 310"])
  })

  /**
   * ⚠ "SIGNED OUT" AND "NOT ASKED YET" ARE BOTH AN ABSENT VIEWER, AND ONLY `ready` TELLS THEM
   * APART — so a reply that never flipped it left the account row saying "Account" forever rather
   * than "Not signed in". A reply is a reply even when the gateway was never reached.
   */
  test("counts an unreachable answer as the server having replied", async () => {
    await ensureCatalog("server-a", () =>
      Promise.resolve({ status: "unreachable", courses: [], assistants: [], modelTiers: {} } satisfies Catalog),
    )

    expect(ready()).toBe(true)
    expect(viewer()).toBeUndefined()
  })

  test("a different server is a different question", async () => {
    let calls = 0
    const load = () => {
      calls++
      return Promise.resolve(catalog)
    }
    await ensureCatalog("server-a", load)
    await ensureCatalog("server-b", load)
    expect(calls).toBe(2)
  })
})

describe("resetCatalog", () => {
  /**
   * ⚠ SIGNING IN IS WHY THIS EXISTS. The app mounts before the student has signed in, so the first
   * ask is answered with an empty catalogue; signing in restarts the sidecar on THE SAME host and
   * port, so nothing about the server looks different and the empty answer would stand until the
   * app was restarted.
   */
  test("clears the answer and re-asks the same server", async () => {
    let calls = 0
    const load = () => {
      calls++
      return Promise.resolve(catalog)
    }
    await ensureCatalog("server-a", load)
    const before = catalogGeneration()

    resetCatalog()
    expect(ready()).toBe(false)
    expect(enrolledCourses()).toEqual([])
    expect(courseById("7")).toBeUndefined()
    // The key carries the generation, so the effect that owns the fetch has something to re-run on.
    expect(catalogGeneration()).toBe(before + 1)

    await ensureCatalog(`server-a#${catalogGeneration()}`, load)
    expect(calls).toBe(2)
  })

  // Leaving the previous account's tiers behind has the coaching nudge reasoning about models this
  // student cannot run.
  test("takes the model tiers with it", async () => {
    await ensureCatalog("server-a", () => Promise.resolve(catalog))
    expect(modelTier("jolli/uuid-opus")).toBe("premium")
    // A model the gateway did not classify draws no nudge rather than a guessed one.
    expect(modelTier("jolli/uuid-unknown")).toBeUndefined()

    resetCatalog()
    expect(modelTier("jolli/uuid-opus")).toBeUndefined()
  })

  /**
   * ⚠ THE PRE-SIGN-IN ASK IS STILL RUNNING WHEN THIS HAPPENS, AND NOTHING CANCELS IT. It was
   * answered with an empty catalogue; if that answer is allowed to land after the real one the
   * student meets a blank course picker that no screen will ever refill, because `inFlight` already
   * holds the newer key.
   */
  test("an answer to the question before the reset is dropped", async () => {
    let answer: ((value: Catalog) => void) | undefined
    const pending = ensureCatalog(
      `server-a#${catalogGeneration()}`,
      () => new Promise<Catalog>((resolve) => (answer = resolve)),
    )

    resetCatalog()
    await ensureCatalog(`server-a#${catalogGeneration()}`, () => Promise.resolve(catalog))
    expect(enrolledCourses().length).toBe(1)

    /**
     * ⚠ `ok` THOUGH THIS ANSWER IS THROWN AWAY. The point of the case is that a reset makes the
     * in-flight request stale, not that it failed — labelling it `unreachable` would put a second
     * reason in a test that is about generations.
     */
    answer!({ status: "ok", courses: [], assistants: [], modelTiers: {} })
    await pending
    expect(enrolledCourses().length).toBe(1)
    expect(modelTier("jolli/uuid-opus")).toBe("premium")
  })
})
