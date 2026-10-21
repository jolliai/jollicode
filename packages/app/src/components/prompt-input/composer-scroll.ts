import type { scrollKey } from "@opencode-ai/ui/scroll-view"

export type ComposerScrollKey = NonNullable<ReturnType<typeof scrollKey>>

/**
 * Which scroll key, if any, the conversation should answer while the composer holds focus.
 *
 * Apart from the page that asks it so the rule can be read — and tested — without a session around
 * it. It was inline before, and inline is where it went wrong: asked of the editor rather than of
 * the box that scrolls, it handed every page key to the timeline and left a long draft unpageable
 * with nothing able to notice.
 *
 * ⚠ PAGING IS THE CONVERSATION'S WHOEVER FOCUSED THE BOX. The box is three lines tall and a caret
 * has no use for a page, so PageUp and PageDown keep meaning what they meant before the box began
 * holding focus at rest (see `claimComposerFocus`).
 *
 * ⚠ BUT ONLY THE TWO KEYS THEMSELVES — `page-down` IS ALSO WHAT A SPACE IS CALLED HERE. `scrollKey`
 * answers Space with `page-down` and Shift+Space with `page-up`, which is the browser's own rule and
 * the right one for a page nobody is typing into. Reading the answer without the key behind it made
 * Space unconditional too, and a space typed into a box the student had clicked into was swallowed
 * mid-word: `hello world` arrived as `helloworld` while the conversation jumped a page. Space is a
 * character first; it pages only on the terms below.
 *
 * ⚠ THE REST ONLY WHILE THE FOCUS IS THE PAGE'S OWN DOING. Space, Home, End and the arrows all mean
 * something to a caret, so they are the student's the moment the box is — they type into it, click
 * into it or tab to it, and it stops answering here.
 *
 * ⚠ AND A DRAFT IN THE BOX DOES NOT MAKE IT THEIRS. That was the first rule written here and it was
 * the wrong one: a draft is from earlier, while `focusUnasked` is about the gesture just made — they
 * clicked on the conversation to read it. Reading the draft as consent meant Space stopped scrolling
 * and started typing a space into the middle of it, which is worse than not scrolling, because
 * nothing on screen says it happened.
 *
 * ⚠ AND NEVER BEFORE THE BOX HAS SCROLLED ITSELF. A draft taller than the box pages within it first.
 */
export function composerScrollRouting(input: {
  key: ComposerScrollKey | undefined
  /** `event.key` as pressed. Required: `page-down` alone cannot tell PageDown from a space. */
  pressed: string
  /** Whether the page took the composer's focus by itself — see `composerFocusUnasked`. */
  focusUnasked: boolean
  composerCanScroll: (key: ComposerScrollKey) => boolean
}) {
  const { key } = input
  if (!key) return undefined
  const paging = input.pressed === "PageUp" || input.pressed === "PageDown"
  if (!paging && !input.focusUnasked) return undefined
  if (input.composerCanScroll(key)) return undefined
  return key
}
