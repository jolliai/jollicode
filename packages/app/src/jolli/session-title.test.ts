import { describe, expect, test } from "bun:test"
import { defaultSessionTitle, SESSION_TITLE_LIMIT } from "./session-title"

describe("defaultSessionTitle", () => {
  test("names a session after its course and the first thing typed", () => {
    expect(defaultSessionTitle({ course: "CS 310", text: "why does my quicksort go out of bounds" })).toBe(
      "CS 310 · why does my quicksort go out of bounds",
    )
  })

  test("falls back to the message alone outside a course", () => {
    expect(defaultSessionTitle({ text: "why does my quicksort go out of bounds" })).toBe(
      "why does my quicksort go out of bounds",
    )
  })

  test("collapses the newlines a pasted prompt brings with it", () => {
    expect(defaultSessionTitle({ course: " CS 310 ", text: "  fix this:\n\n  for (;;) {}\n" })).toBe(
      "CS 310 · fix this: for (;;) {}",
    )
  })

  test("stays within the server's own cap on a title", () => {
    const title = defaultSessionTitle({ course: "CS 310", text: "a".repeat(400) })!
    expect(title.length).toBe(SESSION_TITLE_LIMIT)
    expect(title.startsWith("CS 310 · ")).toBeTrue()
    expect(title.endsWith("…")).toBeTrue()
  })

  /**
   * A submission carrying only images or only review comments has no text, and "CS 310" alone would
   * be the same title on every row of that course. Omitting it leaves the session on the server's
   * default, which is the one case its own titler is still there for.
   */
  test("declines to name a session that has no message", () => {
    expect(defaultSessionTitle({ course: "CS 310", text: "   \n  " })).toBeUndefined()
    expect(defaultSessionTitle({ text: "" })).toBeUndefined()
  })

  test("drops a course prefix that would leave no room for the message", () => {
    expect(defaultSessionTitle({ course: "C".repeat(120), text: "hello" })).toBe("hello")
  })
})
