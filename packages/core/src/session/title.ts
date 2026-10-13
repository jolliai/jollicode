export * as SessionTitle from "./title"

/**
 * THE TITLE A SESSION IS CREATED WITH WHEN NOBODY NAMED IT, AND HOW TO RECOGNISE ONE.
 *
 * ⚠ ONE COPY FOR THE SERVER AND THE DESKTOP. The server writes these and later asks whether a title
 * is still one of them before generating a real one; the desktop asks the same question before it
 * replaces one with its own. A second, hand-copied pattern would stop matching the first time this
 * format changed, and nothing would fail to compile.
 */
export const parentPrefix = "New session - "
export const childPrefix = "Child session - "

const defaultTitle = new RegExp(`^(${parentPrefix}|${childPrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`)

export function isDefault(title: string) {
  return defaultTitle.test(title)
}
