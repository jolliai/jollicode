/**
 * WHAT THE START ROUTE RECORDED ON A SESSION THE GATEWAY OPENED — READ OFF THE SESSION ITSELF.
 *
 * ⚠ ONE READER FOR THREE SURFACES. The sidecar decides from it whether a binding is still writable,
 * and the desktop and the TUI decide from it whether to draw the opener; three copies of the rule had
 * already drifted on whether blank text counts.
 *
 * ⚠ IT IS WRITTEN FOR EVERY STARTED SESSION, OPENER OR NOT. `sessionID` alone records that the
 * gateway's conversation exists and is bound; `text` is there only when the gateway answered with an
 * opener. A Start that got none — AI switched off, the generator busy or failing — is just as bound
 * on the gateway as one that did.
 *
 * ⚠ ONLY UNDER THE SESSION IT WAS WRITTEN FOR. A fork or a child copies the metadata it rides in, but
 * not the gateway's conversation; the id it carries is how a copy is told apart from the original.
 */
type SessionLike = { id: string; metadata?: Record<string, unknown> | undefined }

/** Whether Start opened this session on the gateway, whether or not it came with an opener. */
export function openedOnGateway(session: SessionLike | undefined) {
  return startRecordOf(session) !== undefined
}

/** The opener's text for this session, or undefined when there is none to show. */
export function openerTextOf(session: SessionLike | undefined) {
  const text = startRecordOf(session)?.text
  return typeof text === "string" ? text.trim() || undefined : undefined
}

function startRecordOf(session: SessionLike | undefined) {
  const value = session?.metadata?.["jolliOpener"]
  if (!session || !value || typeof value !== "object") return undefined
  const record = value as { sessionID?: unknown; text?: unknown }
  return record.sessionID === session.id ? record : undefined
}

/**
 * WHAT A START CALL ANSWERED, AND WHETHER IT MUST BE RETRIED UNDER THE SAME ID.
 *
 * ⚠ ONLY A START THAT GOT NO ANSWER IS RETRIED UNDER ITS ID — no response, a 5xx, or `unreachable`.
 * The gateway may have made the conversation all the same, and a fresh id would orphan it.
 *
 * ⚠ A 4XX IS AN ANSWER, NOT A SILENCE. The route rejects what it cannot run — ids that are not the
 * gateway's, a payload it cannot read — before anything is made anywhere, so nothing is left to
 * reclaim and the next Start owes this id nothing.
 *
 * ⚠ THE CALL MUST BE MADE WITH `throwOnError`. That is what has the SDK throw an `Error` carrying the
 * response status under `cause` (see `wrapClientError`); without it an HTTP error and a dropped
 * connection come back looking the same.
 */
export function settleStart<T extends { status: string }>(call: Promise<{ data?: T }>) {
  return call.then(
    (response) => ({ result: response.data, unanswered: !response.data || response.data.status === "unreachable" }),
    (error: unknown) => ({ result: undefined, unanswered: !answeredWithStatus(error) }),
  )
}

function answeredWithStatus(error: unknown) {
  if (!(error instanceof Error) || typeof error.cause !== "object" || error.cause === null) return false
  if (!("status" in error.cause)) return false
  return typeof error.cause.status === "number" && error.cause.status < 500
}
