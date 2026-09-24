/**
 * TELLING JOLLI EDU WHAT A SESSION IS CALLED.
 *
 * ⚠ THE GATEWAY HAS NO OTHER WAY TO KNOW. It creates a coding-agent conversation from the first
 * model call's headers — no title, auto-titling off — and the title this client generates or the
 * student types stays in the local session store. Without this push the web lists every Jolli Code
 * session as untitled.
 *
 * ⚠ IT NEVER FAILS ITS CALLER. A title is a label, not the work: signed out, unreachable or refused
 * all end here as a log line, and the local title is untouched either way.
 */
import { Effect, Schedule } from "effect"
import { renameConversation } from "./api"
import { JolliSession } from "./session"

export const syncTitle = Effect.fn("Jolli.syncTitle")(function* (sessionID: string, title: string) {
  const session = yield* JolliSession.Service
  const request = yield* session.request().pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!request) return
  yield* renameConversation(request, sessionID, title).pipe(
    /**
     * ⚠ 404 IS RETRIED BECAUSE THE TITLE CAN OUTRUN THE CONVERSATION. The title is generated
     * alongside the first turn, not after it, so its PATCH can reach the gateway before the model
     * call that creates the conversation does. About fifteen seconds of backoff covers that race;
     * anything longer is a conversation that is genuinely not there.
     */
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4, while: (error) => error.status === 404 }),
    Effect.catch((error) => {
      if (error.status === 401) return session.refused(request.token).pipe(Effect.ignore)
      return Effect.logDebug("Jolli: conversation title not synced", { sessionID, status: error.status })
    }),
  )
})
