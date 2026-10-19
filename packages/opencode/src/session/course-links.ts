/**
 * WHAT A COURSE TURN'S REPLY CARRIES BESIDE ITS TEXT, AS THE GATEWAY DECIDED IT FOR THAT TURN.
 *
 * Today one thing: the course's Assignments page, when the turn asked about assignments the session's
 * agent does not read. The reply says it cannot look them up; the renderers draw the way there beside
 * it — a button on the desktop, a link in the TUI. Only the gateway can tell what the turn asked, so
 * this asks it, by the turn id it was handed for the turn's steps: the student message that opened it.
 *
 * Runs once a course turn is over, in the background, and writes onto the answer's text part, where
 * both renderers read it (`JolliSources.turnAssignmentsUrl`).
 *
 * ⚠ NOTHING IS WRITTEN WHEN IT FAILS. A reply without the link is the honest rendering of not knowing
 * one; the reason goes to the caller's log.
 */
export * as CourseLinks from "./course-links"
import { fetchCourseTurnLinks } from "@opencode-ai/core/jolli/api"
import { JolliSession } from "@opencode-ai/core/jolli/session"
import { JolliSources } from "@opencode-ai/core/jolli/sources"
import { Effect } from "effect"
import { CourseSources } from "./course-sources"
import type { MessageID, SessionID } from "./schema"
import { Session } from "./session"

export const attach = Effect.fn("CourseLinks.attach")(function* (input: {
  readonly sessionID: SessionID
  readonly userMessageID: MessageID
}) {
  const sessions = yield* Session.Service
  const jolli = yield* JolliSession.Service
  const turn = yield* CourseSources.answerOf(sessions, input)
  if (!turn?.answerPart || turn.answerPart.metadata?.assignmentsUrl !== undefined) return
  const request = yield* jolli.request()
  if (!request) return
  const links = yield* fetchCourseTurnLinks(request, input.sessionID, input.userMessageID)
  if (!links.assignmentsUrl || !JolliSources.isWebUrl(links.assignmentsUrl)) return
  // Read again just before the write, as the sources are: the part may have changed or gone meanwhile.
  const current = yield* sessions.getPart({
    sessionID: input.sessionID,
    messageID: turn.answerPart.messageID,
    partID: turn.answerPart.id,
  })
  if (current?.type !== "text") return
  yield* sessions.updatePart({
    ...current,
    metadata: { ...current.metadata, assignmentsUrl: links.assignmentsUrl },
  })
})
