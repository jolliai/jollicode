import { describe, expect, test } from "bun:test"
import { TypedText } from "@/session/typed-text"

/** The text each range of `typed` covers. */
function covered(typed: TypedText.Info) {
  return typed.ranges.map(([start, end]) => typed.text.slice(start, end))
}

describe("TypedText.join", () => {
  test("moves each piece's ranges to where it lands, leaving empty pieces and their separators out", () => {
    const joined = TypedText.join(["[User]: ", TypedText.typed("Li Ming"), "", "[Attached file]"], "\n")
    expect(joined.text).toBe("[User]: \nLi Ming\n[Attached file]")
    expect(covered(joined)).toEqual(["Li Ming"])
  })

  test("joins nothing to an empty text", () => {
    expect(TypedText.join([], ", ")).toEqual({ text: "", ranges: [] })
    expect(TypedText.typed("")).toEqual({ text: "", ranges: [] })
  })
})

describe("TypedText.slice", () => {
  test("keeps the part of each range the slice holds, measured from its start", () => {
    const sliced = TypedText.slice(TypedText.join(["a ", TypedText.typed("bcd"), " e"]), 3, 6)
    expect(sliced.text).toBe("cd ")
    expect(covered(sliced)).toEqual(["cd"])
  })
})

describe("TypedText.trim", () => {
  test("shifts the ranges with the leading whitespace it removes and clips them at the trailing", () => {
    const trimmed = TypedText.trim(TypedText.join(["  Do ", TypedText.typed("it now  ")]))
    expect(trimmed.text).toBe("Do it now")
    expect(covered(trimmed)).toEqual(["it now"])
  })
})

describe("TypedText.splice", () => {
  test("keeps what a range holds outside the span it replaces, and shifts the ranges after it", () => {
    const typed = TypedText.join([TypedText.typed("abc"), " x ", TypedText.typed("def")])
    const spliced = TypedText.splice(typed, 2, 5, TypedText.typed("ZZ"))
    expect(spliced.text).toBe("abZZ def")
    expect(covered(spliced)).toEqual(["ab", "ZZ", "def"])
  })

  test("counts plain replacement text as no one's typing", () => {
    const spliced = TypedText.splice(TypedText.typed("abc"), 1, 2, "--")
    expect(spliced.text).toBe("a--c")
    expect(covered(spliced)).toEqual(["a", "c"])
  })
})
