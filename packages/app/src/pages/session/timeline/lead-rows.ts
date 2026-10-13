import { openerTextOf } from "@opencode-ai/core/jolli/opener"
import { TimelineRow } from "./timeline-row"

/**
 * THE ROWS ABOVE THE FIRST TURN: THE ASSISTANT'S BRIEF, THEN THE AGENT'S OPENER.
 *
 * ⚠ NOTHING UNTIL THE WHOLE HISTORY IS LOADED. Both belong at the top of the conversation, and
 * while older turns are still to come the top of what is loaded is not the top of the chat.
 *
 * ⚠ THE OPENER IS A ROW OF ITS OWN, NOT A MESSAGE. It never went through the model loop, so there
 * is no message to show — and an assistant message with no user turn above it would be dropped by
 * `constructSessionMessageRows` anyway.
 *
 * ⚠ AND ONLY UNDER THE SESSION IT WAS WRITTEN FOR — see `openerTextOf`.
 */
export function constructLeadRows(input: {
  sessionID: string | undefined
  metadata: Record<string, unknown> | undefined
  brief: string | undefined
  historyComplete: boolean
}) {
  if (!input.sessionID || !input.historyComplete) return []
  const brief = input.brief?.trim()
  const opener = openerTextOf({ id: input.sessionID, metadata: input.metadata })
  return [
    ...(brief ? [new TimelineRow.Brief({ text: brief })] : []),
    ...(opener ? [new TimelineRow.Opener({ sessionID: input.sessionID, text: opener })] : []),
  ]
}
