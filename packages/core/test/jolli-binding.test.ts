import { describe, expect, test } from "bun:test"
import { courseBindingOf } from "../src/jolli/binding"

describe("courseBindingOf", () => {
  test("reads the binding the server carries on the session", () => {
    expect(
      courseBindingOf({
        metadata: { jolli: { courseId: "7", assistantId: "12", sharing: { staff: true, everyone: false } } },
      }),
    ).toEqual({ courseId: "7", assistantId: "12", sharing: { staff: true, everyone: false } })
  })

  test("a session nobody bound is unbound, not broken", () => {
    expect(courseBindingOf(undefined)).toBeUndefined()
    expect(courseBindingOf({})).toBeUndefined()
    expect(courseBindingOf({ metadata: {} })).toBeUndefined()
  })

  /**
   * ⚠ `metadata` IS AN UNTYPED BAG SHARED WITH OTHER FEATURES, so anything shaped wrong reads as
   * unbound rather than throwing. This runs inside a render — a session written by an older build,
   * or by something that put a string there, must not take the transcript down with it.
   */
  test("nonsense reads as unbound rather than throwing", () => {
    for (const jolli of ["", 0, [], null, { courseId: "7" }, { assistantId: "12" }, { courseId: 7, assistantId: 12 }]) {
      expect(courseBindingOf({ metadata: { jolli } as Record<string, unknown> })).toBeUndefined()
    }
  })

  // Sharing is two independent grants; a missing or partial one defaults to granting nothing.
  test("absent sharing grants nobody", () => {
    expect(courseBindingOf({ metadata: { jolli: { courseId: "7", assistantId: "12" } } })?.sharing).toEqual({
      staff: false,
      everyone: false,
    })
    expect(
      courseBindingOf({ metadata: { jolli: { courseId: "7", assistantId: "12", sharing: { staff: "yes" } } } })
        ?.sharing,
    ).toEqual({ staff: false, everyone: false })
  })

  test("leaves other features' metadata alone", () => {
    expect(
      courseBindingOf({ metadata: { somethingElse: { a: 1 }, jolli: { courseId: "7", assistantId: "12" } } })?.courseId,
    ).toBe("7")
  })
})
