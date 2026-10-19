/**
 * WHAT TO TELL A STUDENT WHEN THE GATEWAY REFUSES A CHAT, BY THE REFUSAL'S CODE.
 *
 * ⚠ TWO TABLES, ONE PER MOMENT, AND THE SAME CODES IN BOTH. A refusal reaches a student either as a
 * Start that created nothing or as a turn refused in a chat that already exists, and the same code
 * means a different next step in each: a closed agent's chat can still be read, but a refused Start
 * left nothing to read; a binding conflict on Start is worth one more try, but on a live chat it is
 * permanent. Keeping both here is what stops the provider error, the sidecar and the TUI from each
 * wording them their own way.
 *
 * ⚠ ENGLISH, AND THE DESKTOP DOES NOT RENDER IT DIRECTLY. The provider error is English everywhere
 * already; the desktop's own copy goes through its i18n dictionary, keyed by the same codes.
 *
 * ⚠ THE SENTENCES ARE THE WEB'S where the web has one, so a student who uses both reads the same
 * words. "No longer available" and "archived" have no web counterpart yet.
 */

import { Option, Schema } from "effect"

/** A turn refused in a chat that already exists — what the provider error says. */
export const TURN_REFUSAL = {
  assistant_not_open: "This agent isn't open yet.",
  assistant_closed: "This agent has closed. You can still read this chat.",
  assistant_not_found: "This agent is no longer available.",
  course_not_found: "This agent is no longer available.",
  session_not_found: "This chat can't continue. Start a new chat.",
  session_binding_conflict: "This chat can't continue. Start a new chat.",
  course_archived: "This course is archived.",
} as const

export type RefusalCode = keyof typeof TURN_REFUSAL

/** A Start that created nothing — what the draft screen says. */
export const START_REFUSAL = {
  ...TURN_REFUSAL,
  assistant_closed: "This agent has closed.",
  session_not_found: "Couldn't start the chat. Try again.",
  session_binding_conflict: "Couldn't start the chat. Try again.",
} as const satisfies Record<RefusalCode, string>

/** The sentence for a code this table knows, or undefined for anything else — including no code. */
export function turnRefusalMessage(code: unknown) {
  return isRefusalCode(code) ? TURN_REFUSAL[code] : undefined
}

export function startRefusalMessage(code: unknown) {
  return isRefusalCode(code) ? START_REFUSAL[code] : undefined
}

export function isRefusalCode(code: unknown): code is RefusalCode {
  return typeof code === "string" && Object.hasOwn(TURN_REFUSAL, code)
}

const decodeCode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ code: Schema.String })))

/** The refusal code a gateway error body carries, or undefined for any other body. */
export function refusalCodeOf(body: unknown) {
  const code = Option.getOrUndefined(decodeCode(body))?.code
  return isRefusalCode(code) ? code : undefined
}

/**
 * A TURN AN ASSIGNMENT REFUSED, WORDED BY THE GATEWAY.
 *
 * ⚠ NOT IN THE TABLES ABOVE, BECAUSE THE SENTENCE IS NOT OURS. An assignment's refusal names its due
 * date, its teacher and what to do next, in the time zone the agent reads the assignment in; only the
 * gateway can say that, so the body's `error` is the sentence. An ordinary turn is refused with a
 * normal reply and never reaches here — this is the compaction the gateway would not run.
 */
export const ASSIGNMENT_TURN_REFUSED = "assignment_turn_refused"

const decodeAssignmentRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ code: Schema.Literal(ASSIGNMENT_TURN_REFUSED), error: Schema.String })),
)

/** The gateway's sentence for an assignment's refused turn, or undefined for any other body. */
export function assignmentRefusalOf(body: unknown) {
  return Option.getOrUndefined(decodeAssignmentRefusal(body))?.error
}
