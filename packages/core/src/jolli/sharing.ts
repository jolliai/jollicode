/**
 * WHO CAN READ A SESSION, COMPOSED IN ONE PLACE.
 *
 * Ported from the professor-facing mock (jolli-edu-design, `app/src/data/sharing.ts`). The
 * professor picks a policy there and the student meets it here, so the two surfaces must give the
 * same answer and, where they say it out loud, say it the same way.
 *
 * ⚠ IT SITS IN CORE RATHER THAN IN A RENDERER BECAUSE BOTH RENDERERS SEED A BINDING NOW. The
 * desktop app offers the visibility switches and the TUI does not, but both have to write the
 * SAME starting value into a new session's metadata — a session whose readers depend on which
 * client created it would be a disclosure rule decided by accident. Only `defaultSessionSharing`
 * is on the TUI's path today; the rest is here so the answer stays in one file when it is not.
 *
 * ⚠ ONE ADAPTATION, MADE DELIBERATELY: the web product calls a thread a **chat** and its
 * terminology canon forbids "session" for one. This product calls it a **session**, which is how a
 * student tells the two apart — the same way Claude distinguishes a Chat from a Code session.
 *
 * ⚠ A POLICY AND A SESSION'S READERS ARE DIFFERENT THINGS, AND THIS FILE KEEPS THEM APART. The
 * course's `ChatSharing` decides what a NEW session starts as and whether staff access can be
 * withdrawn; `SessionSharing` is what is true of the session in front of the student, and it is
 * theirs to change from then on. The web mock draws exactly this line (`Course.chatSharing` versus
 * `Conversation.staffShared` / `shares`), and it draws it because a course switching its default in
 * week six must not silently re-open or close ten sessions a student already had.
 *
 * ⚠ THE PROFESSOR-FACING OPTION TABLE IS NOT PORTED. `SHARING_OPTIONS` is written in the first
 * person about the professor ("Shared with me", "Always shared with me") for a control only they
 * see. This surface offers a student two switches instead, so carrying the table over meant
 * relabelling every row of it — three sentences kept in sync with a table nothing here reads.
 */

import { Jolli } from "@opencode-ai/schema/jolli"

/**
 * HOW MUCH EACH POLICY WITHHOLDS, USED ONLY TO RESOLVE A CONFLICT. Not exported: nothing outside
 * this file should be ranking policies, because "stricter" is not a question any screen asks.
 */
const STRICTNESS: Record<Jolli.ChatSharing, number> = {
  private: 0,
  staff: 1,
  "staff-required": 2,
}

/**
 * THE POLICY IN FORCE FOR A SESSION WITH THIS ASSISTANT IN THIS COURSE.
 *
 * ⚠ THE ASSISTANT WINS OVER THE COURSE, AND THE STRICTEST ASSISTANT WINS OVER THE OTHERS. A course
 * sets a default; an assistant configured for something sensitive overrides it. Taking the maximum
 * rather than the last one read means the answer does not depend on array order.
 *
 * ⚠ AND "STRICTEST" MEANS MOST READABLE, NOT MOST RESTRICTIVE, which is worth saying because the
 * word pulls the other way. The risk being managed is a session a professor believes they can read
 * and cannot. `private` losing a tie is the safe direction. (Ported reasoning, verbatim intent.)
 *
 * ⚠ ONE ASSISTANT IS THE ONLY CASE THIS SURFACE PRODUCES, and the signature still takes a list.
 * The web product runs several assistants in one chat, and keeping the shapes aligned is worth more
 * than the two characters saved by narrowing it here.
 */
export function effectiveSharing(
  course: Jolli.Course | undefined,
  assistants: Jolli.Assistant[] = [],
): Jolli.ChatSharing | undefined {
  const overrides = assistants.map((a) => a.chatSharing).filter((p): p is Jolli.ChatSharing => !!p)
  if (overrides.length === 0) return course?.chatSharing
  return overrides.reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a))
}

/**
 * WHAT A NEW SESSION STARTS AS. The one legitimate place a policy becomes a stored value.
 *
 * ⚠ CLASSMATES ARE NEVER ON AT THE START, WHATEVER THE COURSE SAYS. A course policy is about what
 * its staff can see; nothing in it is a statement about the student's peers, and a session that
 * arrived pre-shared with two hundred classmates would be a disclosure the student never made.
 * Sharing with the class is an act, and it happens in the composer.
 */
export function defaultSessionSharing(
  course: Jolli.Course | undefined,
  assistants: Jolli.Assistant[] = [],
): Jolli.SessionSharing {
  const policy = effectiveSharing(course, assistants)
  return { staff: policy === "staff" || policy === "staff-required", everyone: false }
}

/**
 * WHETHER THE STUDENT MAY WITHDRAW STAFF ACCESS.
 *
 * ⚠ FALSE DOES NOT MEAN HIDE THE CONTROL. Show it, refuse it, and say who owns it: a missing
 * control tells a student nothing about why, while a disabled one with an attribution tells them
 * their professor decided, which is true and is the thing they would otherwise go and ask.
 *
 * ⚠ IT IS ABOUT WITHDRAWING ONLY. Sharing WITH staff is never blocked in any course — ported
 * verbatim from the web mock, where a session that was private before the course switched to
 * `staff-required` stays private and the student may still hand it over.
 */
export function mayMakePrivate(course: Jolli.Course | undefined, assistants: Jolli.Assistant[] = []): boolean {
  return effectiveSharing(course, assistants) !== "staff-required"
}
