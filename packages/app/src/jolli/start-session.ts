/**
 * WHAT A FAILED START SAYS ON THE DRAFT SCREEN, BY THE GATEWAY'S REFUSAL CODE.
 *
 * ⚠ THE SAME CODES AS `START_REFUSAL` IN `core/jolli/refusal.ts`, WORDED THROUGH THE DICTIONARY.
 * That table is English for the TUI; the desktop puts everything a student reads through i18n, so it
 * keeps keys instead. The `satisfies` is what keeps the two in step: a code added there fails to
 * compile here rather than falling through to the generic sentence, and the test checks the English
 * dictionary says the same words.
 */

import { isRefusalCode, type RefusalCode } from "@opencode-ai/core/jolli/refusal"

const START_REFUSAL = {
  assistant_not_open: "prompt.jolli.refusal.notOpen",
  assistant_closed: "prompt.jolli.refusal.closed",
  assistant_not_found: "prompt.jolli.refusal.gone",
  course_not_found: "prompt.jolli.refusal.gone",
  course_archived: "prompt.jolli.refusal.archived",
  session_not_found: "prompt.jolli.start.failed",
  session_binding_conflict: "prompt.jolli.start.failed",
} as const satisfies Record<RefusalCode, string>

export type StartErrorKey = (typeof START_REFUSAL)[RefusalCode]

/** The sentence for a refusal's code; an unknown code, no code, or no answer at all gets "try again". */
export function startErrorKey(code: unknown): StartErrorKey {
  return isRefusalCode(code) ? START_REFUSAL[code] : "prompt.jolli.start.failed"
}
