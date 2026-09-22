import { describe, expect, test } from "bun:test"
import { needsCourseChoice, submissionBlocker } from "../../src/context/jolli"

const base = { lockdown: true, signedIn: true, started: false, bound: false, loaded: true, courses: 2, startable: 2 }

describe("submissionBlocker", () => {
  /**
   * ⚠ A BARE `opencode` BUILD MUST BE UNTOUCHED BY ANY OF THIS. The shipped `jollicode` entry point
   * is what sets the lockdown flag; without it there are no courses to demand and refusing would
   * brick a product that never had them.
   */
  test("says nothing at all without lockdown", () => {
    expect(submissionBlocker({ ...base, lockdown: false, loaded: false, courses: 0 })).toBeUndefined()
  })

  test("demands a course before the first prompt of a new session", () => {
    expect(submissionBlocker(base)).toBe("Choose a course before you start — press /course.")
  })

  test("a bound draft may be sent", () => {
    expect(submissionBlocker({ ...base, bound: true })).toBeUndefined()
  })

  /**
   * ⚠ THE SERVER REFUSES TO BIND A COURSE AFTER THE FIRST MESSAGE, so a session that already ran
   * unbound can never acquire one. Refusing to prompt in it would protect nothing and would brick
   * every transcript written before courses existed.
   */
  test("a session that already started is never blocked, bound or not", () => {
    expect(submissionBlocker({ ...base, started: true })).toBeUndefined()
    expect(submissionBlocker({ ...base, started: true, loaded: false, courses: 0 })).toBeUndefined()
  })

  /**
   * ⚠ AN EMPTY CATALOGUE AND ONE THAT HAS NOT ARRIVED LOOK IDENTICAL, so the unloaded case refuses
   * rather than permits — letting it through would create exactly the unbound session this
   * prevents — and it says something different, because the next action is different.
   */
  test("tells waiting apart from having none", () => {
    expect(submissionBlocker({ ...base, loaded: false, courses: 0, startable: 0 })).toBe(
      "Still loading your courses — try again in a moment.",
    )
    expect(submissionBlocker({ ...base, courses: 0, startable: 0 })).toBe(
      "No courses yet. Sign in with /login, or ask your instructor.",
    )
  })

  /**
   * ⚠ ENROLLED BUT NOTHING RUNNABLE IS ITS OWN ANSWER. "Choose a course" sends a student to a
   * picker whose every row is greyed; this one tells them to go and read the reasons, which the
   * dialog carries per course (`Lookup.blockedReason`).
   */
  test("enrolled in nothing startable is not the same as being told to choose", () => {
    expect(submissionBlocker({ ...base, startable: 0 })).toBe(
      "None of your courses can be started yet — press /course to see why.",
    )
  })
  /**
   * ⚠ A CREDENTIAL CAN GO AWAY WHILE THE APP IS RUNNING, which is new: it used to be a 34-day JWT
   * nothing could retire. Another surface signing out removes the shared row, and the backend
   * refusing a renewal makes `jolli/session.ts` delete it. Neither reaches the composer on its own,
   * so without this the prompt went out and came back a gateway 401 the student cannot act on.
   */
  test("refuses while signed out", () => {
    expect(submissionBlocker({ ...base, signedIn: false })).toBe("Signed out. Press /login to sign in again.")
  })

  /**
   * ⚠ AND IT OUTRANKS `started`, WHICH EVERY OTHER REFUSAL YIELDS TO. A session that already ran
   * is exempt from the course rules because the server will not bind one to it any more — that is
   * an argument about bindings, and it says nothing about whether the request can be authenticated.
   * Getting this order wrong is invisible until somebody's session is revoked mid-conversation.
   */
  test("refuses while signed out even in a session that already started", () => {
    expect(submissionBlocker({ ...base, signedIn: false, started: true, bound: true })).toBe(
      "Signed out. Press /login to sign in again.",
    )
  })

  /**
   * ⚠ A BARE `opencode` BUILD HAS NO JOLLI CREDENTIAL TO HOLD, so the flag still decides first.
   */
  test("says nothing about sign-in without lockdown", () => {
    expect(submissionBlocker({ ...base, lockdown: false, signedIn: false, started: true })).toBeUndefined()
  })
})

const choice = { lockdown: true, signedIn: true, started: false, bound: false, loaded: true, startable: 2 }

describe("needsCourseChoice", () => {
  test("opens the picker only when there is a real decision", () => {
    expect(needsCourseChoice(choice)).toBe(true)
  })

  /**
   * ⚠ ONE STARTABLE COURSE IS NOT A DECISION — the context has already bound it by the time this
   * could fire, so putting a picker in front of the student would be asking them to confirm a
   * choice that had no alternatives.
   */
  test("stays out of the way when there is nothing to choose between", () => {
    expect(needsCourseChoice({ ...choice, startable: 1 })).toBe(false)
    expect(needsCourseChoice({ ...choice, startable: 0 })).toBe(false)
  })

  /**
   * ⚠ NONE OF THE CASES A PICKER CANNOT HELP WITH. A catalogue still in flight would open an empty
   * dialog; a bound session has nothing left to ask. `submissionBlocker` covers those with words
   * instead, which is the whole reason the two are separate functions.
   */
  test("never opens over a state the picker cannot answer", () => {
    // Signed out there is no course to offer at all, whatever the catalogue still holds.
    expect(needsCourseChoice({ ...choice, signedIn: false })).toBe(false)
    expect(needsCourseChoice({ ...choice, loaded: false })).toBe(false)
    expect(needsCourseChoice({ ...choice, bound: true })).toBe(false)
    expect(needsCourseChoice({ ...choice, started: true })).toBe(false)
    expect(needsCourseChoice({ ...choice, lockdown: false })).toBe(false)
  })
})
