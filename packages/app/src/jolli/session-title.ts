/**
 * THE TITLE A SESSION IS BORN WITH: the course it belongs to, then what the student actually typed.
 *
 * ⚠ THIS REPLACES "New session", NOT the server's generated title — it REPLACES BOTH. A session is
 * created with `New session - <ISO timestamp>` (`Session.createNext`), which every surface renders
 * as the bare words "New session"; the server then names it properly from the first message once the
 * first turn starts (`SessionPrompt.ensureTitle`). Writing a real title at creation ends that second
 * step too, because `ensureTitle` returns early unless `isDefaultTitle` still holds. That is the
 * trade this module exists to make: a title that is right in the sidebar the instant the student
 * presses Enter, and stays their own words, instead of one that reads "New session" for the length
 * of a model call and then changes under them.
 *
 * ⚠ THE COURSE GOES IN THE TITLE BECAUSE THE SIDEBAR IS WHERE TITLES ARE READ, and there a student
 * is looking at every course at once. `code` rather than `title` — "CS 310", not "Data Structures
 * and Algorithms" — because the row is 300px wide and the whole point is to leave room for the
 * message.
 */

/** The server's own cap on a generated title, kept the same so the two cannot look like two rules. */
export const SESSION_TITLE_LIMIT = 100

/**
 * ⚠ BELOW THIS MUCH ROOM THE COURSE IS DROPPED RATHER THAN THE MESSAGE SHORTENED. A breadcrumb that
 * leaves no room for what the student typed has crowded out the only part that distinguishes one
 * row from the next. No real course code comes close; this is a guard, not a behaviour.
 */
const MESSAGE_MINIMUM = 24

const SEPARATOR = " · "

const collapse = (value: string) => value.replace(/\s+/g, " ").trim()

const clamp = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1)).trimEnd()}…`

/**
 * ⚠ RETURNS `undefined` RATHER THAN A PLACEHOLDER WHEN THERE IS NO MESSAGE. A submission can carry
 * only images or only review comments, and "CS 310" alone is not a title — it is the same string on
 * every row of that course. Omitting it leaves the session on the server's default, which is exactly
 * the case `ensureTitle` is still there for.
 */
export function defaultSessionTitle(input: { course?: string; text: string }) {
  const message = collapse(input.text)
  if (!message) return undefined

  const course = collapse(input.course ?? "")
  if (!course) return clamp(message, SESSION_TITLE_LIMIT)

  const prefix = course + SEPARATOR
  const room = SESSION_TITLE_LIMIT - prefix.length
  if (room < MESSAGE_MINIMUM) return clamp(message, SESSION_TITLE_LIMIT)
  return prefix + clamp(message, room)
}
