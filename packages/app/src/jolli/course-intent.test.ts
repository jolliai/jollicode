import { afterEach, describe, expect, test } from "bun:test"
import { CourseIntent, courseIntentRouteKey } from "./course-intent"

afterEach(() => CourseIntent.clear())

/** The screen the "+" is clicked from. Anything that is not the draft it creates will do. */
const HOME = "home"

describe("CourseIntent", () => {
  /**
   * ⚠ THE REGRESSION THIS FILE EXISTS FOR. An earlier version consumed the request on read, on the
   * reasoning that only one reader should act on it. The draft route mounts TWO
   * `CourseSessionProvider` instances (`DirectoryDataProvider` wrapping `DraftProviders`), so the
   * outer one took the request and the inner one — the one the screen reads — saw nothing and
   * pre-selected the first startable course instead. The clicked course was the one outcome you
   * could not get.
   */
  test("survives being read, so every provider on one draft applies the same course", () => {
    CourseIntent.request("cs-310", HOME)

    expect(CourseIntent.claim("draft:a")).toBe("cs-310")
    expect(CourseIntent.claim("draft:a")).toBe("cs-310")
  })

  test("the latest request wins", () => {
    CourseIntent.request("cs-310", HOME)
    CourseIntent.request("cs-240", HOME)

    expect(CourseIntent.claim("draft:a")).toBe("cs-240")
  })

  test("clearing forgets it", () => {
    CourseIntent.request("cs-310", HOME)
    CourseIntent.clear()

    expect(CourseIntent.pending()).toBeUndefined()
    expect(CourseIntent.claim("draft:a")).toBeUndefined()
  })

  test("reads as absent until something asks", () => {
    expect(CourseIntent.pending()).toBeUndefined()
    expect(CourseIntent.claim("draft:a")).toBeUndefined()
  })

  /**
   * ⚠ THE SECOND REGRESSION, AND THE REASON `claim` REPLACED A BARE `pending()` READ. Nothing
   * cleared the request when a draft was abandoned, so clicking the "+" on CS 240 and then walking
   * away left it armed: the next new session started from anywhere came up bound to CS 240, because
   * the branch that honours a request ignores both the pre-selection latch and an existing draft.
   */
  test("a later draft retires the request instead of inheriting it", () => {
    CourseIntent.request("cs-240", HOME)

    expect(CourseIntent.claim("draft:a")).toBe("cs-240")
    expect(CourseIntent.claim("draft:b")).toBeUndefined()
    expect(CourseIntent.pending()).toBeUndefined()
  })

  /**
   * ⚠ ABANDONING BEFORE ANY PROVIDER READS IT COUNTS TOO. The draft route may never settle — a
   * student can leave while the catalogue is still in flight, so the effect that claims never runs.
   */
  test("an unread request does not survive to a different screen", () => {
    CourseIntent.request("cs-240", HOME)

    expect(CourseIntent.claim("session:ses_1")).toBe("cs-240")
    expect(CourseIntent.claim("draft:b")).toBeUndefined()
  })

  /**
   * ⚠ THE SCREEN THAT ASKED NEVER APPLIES IT. `pending` is a signal, so clicking the "+" on CS 240
   * while already sitting on a draft re-runs THAT draft's effect before the navigation lands —
   * answering there would rebind the draft the student is in the act of leaving, and would burn the
   * claim so the new draft got the default instead.
   */
  test("the requesting screen is skipped, and the draft it creates still gets the course", () => {
    CourseIntent.request("cs-240", "draft:a")

    expect(CourseIntent.claim("draft:a")).toBeUndefined()
    expect(CourseIntent.pending()).toBe("cs-240")
    expect(CourseIntent.claim("draft:b")).toBe("cs-240")
  })
})

describe("courseIntentRouteKey", () => {
  /**
   * ⚠ TWO DRAFTS ARE TWO KEYS, WHICH IS THE WHOLE POINT. `tabs.newDraft` mints a fresh `uuid()` per
   * call, so a `route.type` comparison would read two consecutive "new session" clicks as one
   * screen and hand the second draft a request made for the first.
   */
  test("separates one draft from the next", () => {
    expect(courseIntentRouteKey({ type: "draft", draftID: "a" })).toBe("draft:a")
    expect(courseIntentRouteKey({ type: "draft", draftID: "b" })).toBe("draft:b")
  })

  test("names the other routes without colliding with a draft", () => {
    expect(courseIntentRouteKey({ type: "home" })).toBe("home")
    expect(courseIntentRouteKey({ type: "session", sessionId: "ses_1" })).toBe("session:ses_1")
    expect(courseIntentRouteKey({ type: "dir-new-sesssion", dir: "/tmp", dirBase64: "L3RtcA" })).toBe(
      "dir-new-session:L3RtcA",
    )
  })
})
