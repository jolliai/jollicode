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
 * ⚠ THE REST ONLY WHILE THE FOCUS IS THE PAGE'S OWN DOING. Space, Home, End and the arrows all mean
 * something to a caret, so they are the student's the moment the box is — they type into it or click
 * into it and it stops answering here. Until then the box is empty and parked under a conversation
 * being read, where those keys have only ever meant scroll.
 *
 * ⚠ AND NEVER BEFORE THE BOX HAS SCROLLED ITSELF. A draft taller than the box pages within it first.
 */
export function composerScrollRouting(input: {
  key: ComposerScrollKey | undefined
  /** Whether the page took the composer's focus by itself — see `composerFocusUnasked`. */
  focusUnasked: boolean
  promptEmpty: boolean
  composerCanScroll: (key: ComposerScrollKey) => boolean
}) {
  const { key } = input
  if (!key) return undefined
  const paging = key === "page-up" || key === "page-down"
  if (!paging && !(input.focusUnasked && input.promptEmpty)) return undefined
  if (input.composerCanScroll(key)) return undefined
  return key
}
