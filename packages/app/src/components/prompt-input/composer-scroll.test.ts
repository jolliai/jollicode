import { describe, expect, test } from "bun:test"
import { composerScrollRouting, type ComposerScrollKey } from "./composer-scroll"

const route = (input: {
  key: ComposerScrollKey | undefined
  focusUnasked?: boolean
  promptEmpty?: boolean
  composerCanScroll?: boolean
}) =>
  composerScrollRouting({
    key: input.key,
    focusUnasked: input.focusUnasked ?? true,
    promptEmpty: input.promptEmpty ?? true,
    composerCanScroll: () => input.composerCanScroll ?? false,
  })

describe("composerScrollRouting", () => {
  test("pages the conversation however the box came by its focus", () => {
    expect(route({ key: "page-down", focusUnasked: false, promptEmpty: false })).toBe("page-down")
    expect(route({ key: "page-up", focusUnasked: false, promptEmpty: false })).toBe("page-up")
  })

  test("scrolls the conversation with the caret keys only while the focus is the page's own", () => {
    expect(route({ key: "down" })).toBe("down")
    expect(route({ key: "end" })).toBe("end")
    expect(route({ key: "up", focusUnasked: false })).toBeUndefined()
  })

  test("leaves the caret keys to a box the student has typed into", () => {
    expect(route({ key: "down", promptEmpty: false })).toBeUndefined()
    expect(route({ key: "home", promptEmpty: false })).toBeUndefined()
  })

  test("lets the box scroll itself first", () => {
    expect(route({ key: "page-down", composerCanScroll: true })).toBeUndefined()
    expect(route({ key: "down", composerCanScroll: true })).toBeUndefined()
  })

  test("answers nothing for a key that does not scroll", () => {
    expect(route({ key: undefined })).toBeUndefined()
  })
})
