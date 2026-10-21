import { describe, expect, test } from "bun:test"
import { scrollKey } from "@opencode-ai/ui/scroll-view"
import { composerScrollRouting, type ComposerScrollKey } from "./composer-scroll"

/** The key each routed name comes from when nothing else is said — Space is the one that differs. */
const PRESSED: Record<string, string> = {
  "page-down": "PageDown",
  "page-up": "PageUp",
  home: "Home",
  end: "End",
  up: "ArrowUp",
  down: "ArrowDown",
}

const route = (input: {
  key: ComposerScrollKey | undefined
  /** `event.key`. Defaults to the key the routed name is named after; spell it out for Space. */
  pressed?: string
  focusUnasked?: boolean
  composerCanScroll?: boolean
}) =>
  composerScrollRouting({
    key: input.key,
    pressed: input.pressed ?? PRESSED[input.key ?? ""] ?? "",
    focusUnasked: input.focusUnasked ?? true,
    composerCanScroll: () => input.composerCanScroll ?? false,
  })

const press = (key: string, modifiers: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>> = {}) =>
  scrollKey({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers })

/**
 * A space as it arrives: `scrollKey` renames it, so the routing needs the key beside the name.
 *
 * Annotated because an object literal widens what it is given: `press` answers with the routed
 * names, and the property it lands in says `string`, which `route` then refuses.
 */
const space = (shiftKey = false): { key: ComposerScrollKey | undefined; pressed: string } => ({
  key: press(" ", { shiftKey }),
  pressed: " ",
})

describe("composerScrollRouting", () => {
  test("pages the conversation however the box came by its focus", () => {
    expect(route({ key: "page-down", focusUnasked: false })).toBe("page-down")
    expect(route({ key: "page-up", focusUnasked: false })).toBe("page-up")
  })

  test("scrolls the conversation with the caret keys only while the focus is the page's own", () => {
    expect(route({ key: "down" })).toBe("down")
    expect(route({ key: "end" })).toBe("end")
    expect(route({ key: "up", focusUnasked: false })).toBeUndefined()
    expect(route({ key: "home", focusUnasked: false })).toBeUndefined()
  })

  test("a draft in the box does not make the keys the caret's", () => {
    // The gesture that took focus was a click on the conversation; the draft is from earlier.
    // Reading it as consent put a space in the middle of the draft instead of scrolling.
    expect(route({ key: "page-down" })).toBe("page-down")
    expect(route({ key: "down" })).toBe("down")
  })

  test("a space typed into a box the student focused themselves is a space", () => {
    // `scrollKey` calls it `page-down`, and paging is unconditional — but only for PageDown itself.
    // Reading the name alone swallowed the space mid-word: `hello world` arrived as `helloworld`.
    expect(route({ ...space(), focusUnasked: false })).toBeUndefined()
    expect(route({ ...space(true), focusUnasked: false })).toBeUndefined()
    // The keys it is named after are unaffected: a caret has no use for a page.
    expect(route({ key: "page-down", focusUnasked: false })).toBe("page-down")
  })

  test("lets the box scroll itself first", () => {
    expect(route({ key: "page-down", composerCanScroll: true })).toBeUndefined()
    expect(route({ key: "down", composerCanScroll: true })).toBeUndefined()
  })

  test("answers nothing for a key that does not scroll", () => {
    expect(route({ key: undefined })).toBeUndefined()
  })

  test("space and shift-space both reach the conversation, in opposite directions", () => {
    // The page used to refuse every shifted key on its own, which left Space paging down while
    // Shift+Space typed a space. Modifiers are `scrollKey`'s business alone.
    expect(route({ ...space() })).toBe("page-down")
    expect(route({ ...space(true) })).toBe("page-up")
  })

  test("leaves genuinely modified keys alone", () => {
    expect(route({ key: press("PageDown", { ctrlKey: true }) })).toBeUndefined()
    expect(route({ key: press("End", { shiftKey: true }) })).toBeUndefined()
    expect(route({ key: press("ArrowUp", { metaKey: true }) })).toBeUndefined()
  })
})
