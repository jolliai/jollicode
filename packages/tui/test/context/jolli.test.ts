import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import { briefPreview, needsCourseChoice, START_FAILED, startOutcome, submissionBlocker } from "../../src/context/jolli"

const base = {
  lockdown: true,
  signedIn: true,
  started: false,
  bound: false,
  loaded: true,
  courses: 2,
  startable: 2,
  noOpenAssistants: false,
}

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
   * ⚠ WHEN THE CLOCK IS ALL THAT STANDS IN THE WAY, THE SENTENCE SAYS SO. Sending the student to
   * `/course` would show them an empty list — every course was hidden for having nothing open.
   */
  test("nothing startable because no assistant is open says so", () => {
    expect(submissionBlocker({ ...base, startable: 0, noOpenAssistants: true })).toBe(
      "No assistants are open right now — try again later.",
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

const choice = {
  lockdown: true,
  signedIn: true,
  started: false,
  bound: false,
  loaded: true,
  consulted: true,
  startable: 2,
}

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

  /**
   * ⚠ THE CATALOGUE AND THE REMEMBERED COURSE ARRIVE SEPARATELY, AND HALF AN ANSWER IS NOT ONE. The
   * effect that reads the memory wakes on the same flag `app.tsx` does and runs after it, so a
   * `loaded` catalogue on its own says nothing about whether this student has already chosen. On a
   * real launch that gap was one millisecond, and it put the picker in front of somebody whose
   * course bound itself underneath it.
   */
  test("waits for the remembered course to be read, not just the catalogue", () => {
    expect(needsCourseChoice({ ...choice, consulted: false })).toBe(false)
  })
})

describe("startOutcome", () => {
  const session = { id: "ses_started" } as Session

  /** ⚠ AN OPENER THE GATEWAY COULD NOT WRITE IS STILL A STARTED CHAT, which the student types into. */
  test("a started session is entered, with or without an opener", () => {
    expect(startOutcome({ status: "started", session, opener: true })).toEqual({
      type: "started",
      sessionID: "ses_started",
      opener: true,
    })
    expect(startOutcome({ status: "started", session, opener: false })).toEqual({
      type: "started",
      sessionID: "ses_started",
      opener: false,
    })
  })

  /** ⚠ A TASK'S REFUSAL NAMES THE ASSIGNMENT'S DATES AND NEXT STEP, WHICH ONLY THE GATEWAY CAN SAY. */
  test("a refused task start says the gateway's own sentence", () => {
    const message = "Lab 4 stopped taking work at its due date. If you need more time, ask Prof. Okafor."
    expect(startOutcome({ status: "refused", code: "submissions_stopped", message })).toEqual({
      type: "failed",
      message,
      refresh: true,
    })
  })

  /** ⚠ A REFUSAL ASKS FOR THE CATALOGUE AGAIN, so the Start it refused is not offered a second time. */
  test("a refusal says why in the student's words and refreshes the catalogue", () => {
    expect(startOutcome({ status: "refused", code: "assistant_not_open" })).toEqual({
      type: "failed",
      message: "This agent isn't open yet.",
      refresh: true,
    })
    expect(startOutcome({ status: "refused", code: "assistant_not_found" })).toEqual({
      type: "failed",
      message: "This agent is no longer available.",
      refresh: true,
    })
  })

  /** ⚠ THERE IS NO CHAT TO "STILL READ" WHEN STARTING ONE WAS REFUSED. */
  test("a closed agent is reported without the sentence about reading the chat", () => {
    expect(startOutcome({ status: "refused", code: "assistant_closed" })).toEqual({
      type: "failed",
      message: "This agent has closed.",
      refresh: true,
    })
  })

  test("a refusal with no code, or one this does not know, falls back to trying again", () => {
    expect(startOutcome({ status: "refused" })).toEqual({ type: "failed", message: START_FAILED, refresh: true })
    expect(startOutcome({ status: "refused", code: "something_new" })).toEqual({
      type: "failed",
      message: START_FAILED,
      refresh: true,
    })
  })

  /**
   * ⚠ NO ANSWER IS NEVER "NO OPENER". The gateway may have written one the student did not see, so
   * nothing is entered — not even an empty chat.
   */
  test("an unreachable gateway, or no readable answer, enters nothing", () => {
    expect(startOutcome({ status: "unreachable" })).toEqual({ type: "failed", message: START_FAILED, refresh: false })
    expect(startOutcome(undefined)).toEqual({ type: "failed", message: START_FAILED, refresh: false })
  })
})

describe("briefPreview", () => {
  test("a blank brief shows nothing", () => {
    expect(briefPreview(undefined, 80)).toBeUndefined()
    expect(briefPreview("  \n ", 80)).toBeUndefined()
  })

  test("folds line breaks and keeps a short brief whole", () => {
    expect(briefPreview("Interview for\n\nthe analyst role.", 80)).toBe("Interview for the analyst role.")
  })

  test("cuts a long brief to a few lines", () => {
    const preview = briefPreview("word ".repeat(200), 40, 3)
    expect(preview?.length).toBe(40 * 3 - "Brief: ".length)
    expect(preview?.endsWith("…")).toBe(true)
  })
})
