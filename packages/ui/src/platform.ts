/**
 * Whether the keyboard in front of the student is an Apple one — the single fact every "what does
 * this shortcut mean" question turns on. ⌘ is the command modifier there and Ctrl belongs to the
 * caret (Ctrl+F is "move forward one character", honoured by every text field on the page);
 * everywhere else Ctrl is the command modifier and ⌘ means nothing.
 *
 * ⚠ ONE COPY, BECAUSE THREE DISAGREEING IS THE FAILURE MODE. The command palette, the keybind
 * settings and the file find each carried this regex, and a shortcut answered on one spelling of
 * "is this a Mac" while drawn on another is a shortcut that shows one thing and does another.
 *
 * `navigator.platform` is deprecated, but it is the only answer every engine still gives:
 * `userAgentData` is Chromium-only and absent from the WebKit builds this also runs in.
 */
export const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)
