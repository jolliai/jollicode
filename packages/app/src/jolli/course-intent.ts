/**
 * "START A SESSION IN THIS COURSE", ASKED FROM OUTSIDE THE CONTEXT THAT CAN ANSWER IT.
 *
 * ⚠ A MODULE SIGNAL RATHER THAN A CONTEXT, FOR THE SAME REASON `model-grant.ts` IS ONE. The sidebar
 * is mounted by `layout-new.tsx`, which is the router root; `CourseSessionProvider` mounts *below*
 * it, on the draft route and inside the directory layout. So the course rows cannot call
 * `draft.setCourse()` — the provider that owns the draft does not exist yet when they are clicked,
 * and it is created by the very navigation the click performs.
 *
 * ⚠ AND THE EXISTING `handoff` MAP COULD NOT BE REUSED, though it solves a similar-looking problem.
 * That one is keyed by session id and covers the frame between creating a session and syncing it
 * back; here there is no session yet and no id to key on.
 *
 * ⚠ IT IS NOT CONSUMED ON READ, AND THE FIRST VERSION OF THIS FILE GOT THAT WRONG. The draft route
 * nests TWO `CourseSessionProvider` instances — `DirectoryDataProvider` wraps `DraftProviders` (see
 * `app.tsx`'s `ResolvedDraftRoute`) — and both run the effect that reads this. A `take()` that
 * cleared as it read handed the request to whichever ran first, which is the OUTER one, and left the
 * inner one — the one the screen actually reads — seeing nothing and falling through to its
 * "pre-select the first startable course" default. The clicked course was the one thing you could
 * not end up with.
 *
 * ⚠ SO IT IS SCOPED TO A ROUTE RATHER THAN TO A READER — {@link CourseIntent.claim} — AND AN EARLIER
 * VERSION HAD NO SCOPE AT ALL. That one cleared on `promote`, on a hand-picked course, and on a
 * course that could not be started; every other way of leaving a draft left the request sitting
 * there. Abandon a draft you opened from the CS 240 row and the next new session you started from
 * anywhere — the Sessions "+", `mod+t`, the home button — silently came up bound to CS 240, because
 * the branch that honours a request deliberately ignores both the latch and an existing draft.
 *
 * Scoping it by route keeps the property that earned the "not consumed on read" rule while closing
 * that hole: every provider standing on ONE draft sees the same answer however many times it asks,
 * and the first provider standing on a DIFFERENT one retires the request instead of inheriting it.
 */

import { createSignal } from "solid-js"
import type { LayoutRoute } from "@/context/layout"

const [pending, setPending] = createSignal<string | undefined>(undefined)

/** The route the request was made from; it is the one screen that must NOT apply it. */
let requestedAt: string | undefined
/** The route that took the request, if one has. Every later route is a different session. */
let claimedBy: string | undefined

/**
 * WHICH SCREEN WE ARE STANDING ON, FOR THE PURPOSE OF "IS THIS STILL THE SAME NEW SESSION".
 *
 * ⚠ THE DRAFT ID IS WHAT MAKES THIS WORK, AND `tabs.newDraft` MINTS A FRESH `uuid()` PER CALL. Two
 * consecutive "new session" clicks are therefore two different keys even though both are drafts,
 * which is exactly the case a `route.type` comparison would miss.
 */
export function courseIntentRouteKey(route: LayoutRoute) {
  if (route.type === "draft") return `draft:${route.draftID}`
  if (route.type === "session") return `session:${route.sessionId}`
  if (route.type === "dir-new-sesssion") return `dir-new-session:${route.dirBase64}`
  return route.type
}

export const CourseIntent = {
  pending,
  /**
   * Ask for the next new session to be bound to this course. Overrides any pre-selected default.
   *
   * `from` is {@link courseIntentRouteKey} for the screen the student clicked on — the request is
   * for the session that screen is about to create, never for the screen itself.
   */
  request(courseId: string, from: string) {
    setPending(courseId)
    requestedAt = from
    claimedBy = undefined
  },
  /**
   * The requested course, if this route is the one the request was for.
   *
   * ⚠ IDEMPOTENT FOR ONE ROUTE, WHICH IS THE WHOLE REASON THIS IS NOT A `take()`. Both providers on
   * the draft route pass the same key and both get the same answer, however many times their
   * effects re-run.
   *
   * ⚠ THE REQUESTING SCREEN GETS NOTHING. Clicking the "+" on CS 240 while already sitting on a
   * draft re-runs that draft's effect before the navigation lands — `pending` is a signal — and
   * answering there would rebind the draft the student is in the act of leaving.
   *
   * ⚠ AND A LATER, DIFFERENT ROUTE RETIRES IT RATHER THAN INHERITING IT. That is the abandon case:
   * the request was for one new session, it is not a standing preference.
   */
  claim(routeKey: string) {
    const courseId = pending()
    if (!courseId) return undefined
    if (routeKey === requestedAt) return undefined
    if (claimedBy === undefined) {
      claimedBy = routeKey
      return courseId
    }
    if (routeKey === claimedBy) return courseId
    CourseIntent.clear()
    return undefined
  },
  /**
   * Forget the request.
   *
   * ⚠ CALLED WHEN THE REQUEST HAS BEEN ANSWERED OR OVERRULED, never merely because somebody read
   * it: on `promote`, when the student chooses a course by hand, and when a request names a course
   * that cannot be started — see `session-binding.tsx`.
   */
  clear() {
    setPending(undefined)
    requestedAt = undefined
    claimedBy = undefined
  },
}
